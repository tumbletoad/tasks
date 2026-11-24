// Open in T3 Code through the service (A4 3.4.1, A7 M2.10t's Verify line): a person's
// `launch.open` over the socket, the hub's launch machine, the paired T3 route against testkit's
// fake T3 server, and a recording spawner as the OS opener, so no link is really opened and no
// real T3 Code is reached. Fixture data and temporary folders only.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { SpawnRequest, SpawnedProcess } from "@ttasks/launch";
import { FakeT3 } from "@ttasks/testkit/fake-t3";
import { instanceToml, tempRoot } from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";
import { ShimLab } from "./shim-harness.ts";

const WINDOWS = process.platform === "win32";
const SYSTEMD_RUN = "/usr/bin/systemd-run";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

/** What the OS opener was given, and whether it answers: `opened`, or never (`hang`). */
const opener = { mode: "opened" as "opened" | "hang", urls: [] as string[] };

function spawner(request: SpawnRequest): Promise<SpawnedProcess> {
  const probe = request.argv[0] === SYSTEMD_RUN && request.argv.includes("--quiet");
  if (!probe) opener.urls.push(request.argv.at(-1) ?? "");
  const exited =
    probe || opener.mode === "opened"
      ? Promise.resolve({ code: 0, signal: null })
      : new Promise<{ code: number | null; signal: string | null }>(() => undefined);
  return Promise.resolve({ pid: 1, exited, stop: () => undefined });
}

interface Rig {
  readonly lab: ShimLab;
  readonly user: RpcSession;
  readonly fake: FakeT3;
}

async function rig(): Promise<Rig> {
  const t3 = tempRoot("t3-open-home");
  const fake = await FakeT3.start(join(t3.root, "t3home"));
  cleanups.push(t3.cleanup, () => fake.stop());
  // Linux's opener needs a desktop session and a `gio`: the spawner never runs it.
  const bin = tempRoot("t3-open-bin");
  cleanups.push(bin.cleanup);
  if (!WINDOWS) {
    writeFileSync(join(bin.root, "gio"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin.root, "gio"), 0o755);
  }
  const lab = await ShimLab.create("t3-open", {
    toml: () => instanceToml({ id: "t3", target: "t3", label: "T3 Code · test" }),
    launch: {
      terminals: { spawn: spawner, systemdRun: SYSTEMD_RUN, openerMs: 200 },
    },
    serviceEnv: {
      T3CODE_HOME: fake.home,
      ...(WINDOWS ? {} : { DISPLAY: ":0", PATH: `${bin.root}:${process.env["PATH"] ?? ""}` }),
    },
  });
  cleanups.push(() => lab.cleanup());
  const user = await classSession(lab.home, lab.running.endpoint.path, "cli-interactive");
  cleanups.push(() => {
    user.close();
  });
  opener.mode = "opened";
  opener.urls.length = 0;
  return { lab, user, fake };
}

let requests = 0;
const rid = (): string => `t3-open-request-${String((requests += 1)).padStart(6, "0")}`;

interface Note {
  readonly ref: string;
  readonly text: string;
}

interface Opened {
  readonly launch: { id: string; reference: string; state: string; reason?: string };
  readonly text: string;
  readonly note?: string;
  readonly link_opened?: boolean;
}

const call = (r: Rig, op: string, input: Record<string, unknown>) =>
  r.user.call("op/call", { space: r.lab.spaceId, op, input }, { timeoutMs: 60_000 });

const open = async (r: Rig, input: Record<string, unknown>): Promise<Opened> =>
  (await call(r, "launch.open", { instance: "t3", request_id: rid(), ...input })) as Opened;

async function refusal(r: Rig, task: string): Promise<unknown> {
  try {
    await open(r, { task });
  } catch (error) {
    return errorOf(error);
  }
  throw new Error("expected a refusal");
}

/** A task with the folder `<work>/<folder>` (made first). */
async function addTask(
  r: Rig,
  title: string,
  folder: string,
): Promise<{ id: string; ref: string }> {
  const added = (await call(r, "task.add", {
    tasks: [{ title }],
    request_id: rid(),
  })) as { tasks: { id: string; ref: string }[] };
  const task = added.tasks[0];
  if (task === undefined) throw new Error("no task");
  mkdirSync(join(r.lab.work, folder), { recursive: true });
  await call(r, "folder.manage", {
    action: "set",
    task: task.ref,
    folder: join(r.lab.work, folder),
    request_id: rid(),
  });
  return task;
}

/** `ttasks setup t3` through the service, approved on the fake's page. */
async function pair(r: Rig): Promise<void> {
  const begun = (await r.user.call("t3/pair", {})) as { attempt: string; url: string };
  expect(await r.fake.approveInBrowser(begun.url)).toBe(200);
  await r.user.call("t3/pair_wait", { attempt: begun.attempt }, { timeoutMs: 60_000 });
}

const threadsOf = (r: Rig, launch: string) =>
  [...r.fake.threads.values()].filter((t) => t.clientRequestId === launch);

describe("[A4.3.4.1.t3.open] Open in T3 Code through the service, against a fake T3", () => {
  test(
    "one click opens one thread with the brief in its composer, at a project root and in a nested folder; the words stay out of the link",
    { timeout: 300_000 },
    async () => {
      const r = await rig();
      const task = await addTask(r, "Fixture T3 task", "lumen");
      // Not paired while T3 runs: Pair. Not running: Start T3 Code comes first.
      expect(await refusal(r, task.ref)).toMatchObject({
        data: { field: "instance", reason: "t3", t3: "not_paired" },
      });
      await r.fake.stop();
      expect(await refusal(r, task.ref)).toMatchObject({ data: { t3: "not_running" } });
      await r.fake.restart();
      await pair(r);

      const lumen = r.fake.addProject(join(r.lab.work, "lumen"), "lumen");
      const words = "Fixture request: read the draft before anything else.";
      const requestId = rid();
      const first = await open(r, { task: task.ref, text: words, request_id: requestId });
      expect(first.launch.state).toBe("confirmed");
      expect(first.link_opened).toBe(true);
      expect(first.text).toBe("request");
      const [thread] = threadsOf(r, first.launch.id);
      expect(thread).toMatchObject({
        projectId: lumen,
        message: false,
        title: `${task.ref} Fixture T3 task`,
      });
      const url = new URL(opener.urls.at(-1) ?? "");
      expect(`${url.protocol}//${url.host}${decodeURIComponent(url.pathname)}`).toBe(
        `t3code://threads/${r.fake.environmentId}/${thread?.id ?? ""}`,
      );
      const prompt = url.searchParams.get("prompt") ?? "";
      expect(prompt).toContain(first.launch.reference);
      expect(prompt).toContain(task.ref);
      // The words are the launch's request, a note on the task, never in the link.
      expect(prompt).not.toContain("Fixture request");
      const page = (await call(r, "task.get", {
        task: task.ref,
        sections: ["instructions", "notes"],
      })) as { sections: { instructions?: Note[]; notes?: Note[] } };
      const notes = [...(page.sections.instructions ?? []), ...(page.sections.notes ?? [])];
      expect(notes.find((n) => n.ref === first.note)?.text).toBe(words);

      // The same click again (a double click, a resend) is that launch: no second thread.
      const again = await open(r, { task: task.ref, text: words, request_id: requestId });
      expect(again.launch.id).toBe(first.launch.id);
      expect(r.fake.threads.size).toBe(1);

      // A slow answer that is lost: the one repeat with the same key gives the same thread.
      r.fake.dropNext("t3_thread_launch", "after");
      const lost = await open(r, { task: task.ref });
      expect(lost.launch.state).toBe("confirmed");
      expect(threadsOf(r, lost.launch.id)).toHaveLength(1);

      // A folder inside the project becomes a project of its own; the containing one is unused.
      const nested = await addTask(r, "Nested fixture task", join("lumen", "docs"));
      const inside = await open(r, { task: nested.ref });
      expect(inside.launch.state).toBe("confirmed");
      const docs = [...r.fake.projects.values()].find(
        (p) => realpathSync(p.workspaceRoot) === realpathSync(join(r.lab.work, "lumen", "docs")),
      );
      expect(threadsOf(r, inside.launch.id).map((t) => t.projectId)).toEqual([docs?.id]);
    },
  );

  test(
    "a thread whose link did not come up stays one thread, and Open in T3 brings it with its brief, then without",
    { timeout: 300_000 },
    async () => {
      const r = await rig();
      await pair(r);
      const task = await addTask(r, "Fixture T3 task", "lumen");
      r.fake.addProject(join(r.lab.work, "lumen"), "lumen");
      opener.mode = "hang";
      const opened = await open(r, { task: task.ref });
      expect(opened.launch.state).toBe("confirmed");
      expect(opened.link_opened).toBe(false);
      opener.mode = "opened";
      const launches = r.lab.running.launches;
      expect(await launches.openThread(r.lab.spaceId, opened.launch.id)).toBe(true);
      expect(new URL(opener.urls.at(-1) ?? "").searchParams.get("prompt")).toContain(
        opened.launch.reference,
      );
      expect(await launches.openThread(r.lab.spaceId, opened.launch.id)).toBe(true);
      expect(new URL(opener.urls.at(-1) ?? "").search).toBe("");
      expect(threadsOf(r, opened.launch.id)).toHaveLength(1);
      expect(r.fake.threads.size).toBe(1);
    },
  );
});
