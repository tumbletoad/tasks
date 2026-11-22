// A7 3.8 M1.08's Verify line: a grep of the logs for fixture strings finds nothing (A2 3.13).
//
// A service runs with everything a log could leak in reach: a seeded fixture space (task titles,
// summaries, notes, log entries, sources, names) in a folder whose path is itself a fixture
// string, its daily backup, agent markers and a ticket in its environment and in a client's bind
// context, its own key, a client refused for a wrong key, a second start that exits 73, a crash
// whose message is a task title, a restart and a graceful stop. Then every file in `<state>/logs`
// and `<state>/crash` is searched for every one of those strings, as written and as JSON would
// escape it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { openRpc } from "@ttasks/bridge/protocol";
import { openSpace } from "@ttasks/storage";
import { checkedDriver, seedMira } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT } from "../src/hub/exit.ts";
import {
  diagnostics,
  endpointInstance,
  EXIT_MS,
  READY_MS,
  readLog,
  removeRuntimeDir,
  Services,
  stateOf,
  tempRoot,
  waitFor,
  waitReady,
  within,
  type ServiceJson,
} from "./harness.ts";

const services = new Services();
const cleanups: (() => void)[] = [];
const runtimeDirs: (ServiceJson | undefined)[] = [];

afterEach(async () => {
  await services.stopAll();
  for (const json of runtimeDirs.splice(0)) removeRuntimeDir(json);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Every piece of text the seeded space holds, read through a reader. */
async function spaceText(folder: string): Promise<{ texts: string[]; machine: string }> {
  const opened = openSpace(await checkedDriver(), folder, { role: "reader" });
  try {
    const texts: string[] = [opened.space.name];
    const queries = [
      "SELECT title AS t FROM tasks UNION ALL SELECT summary FROM tasks UNION ALL SELECT context FROM tasks",
      "SELECT body AS t FROM notes UNION ALL SELECT body FROM log_entries",
      "SELECT title AS t FROM sources UNION ALL SELECT label FROM actors",
      "SELECT title AS t FROM areas UNION ALL SELECT title FROM projects",
      "SELECT brief AS t FROM areas UNION ALL SELECT brief FROM projects",
      "SELECT name AS t FROM machines",
    ];
    for (const sql of queries) {
      for (const row of opened.conn.prepare(sql).all<{ t: unknown }>()) {
        if (typeof row.t === "string") texts.push(row.t);
      }
    }
    return { texts, machine: opened.space.authority.machineId };
  } finally {
    opened.conn.close();
  }
}

/** The forms a string can take in a file: as written, JSON-escaped, and with forward slashes. */
const forms = (text: string): string[] => [
  text,
  JSON.stringify(text).slice(1, -1),
  text.replaceAll("\\", "/"),
];

describe("[A2.3.13.hub.logs-content-free] logs and crash files of a running service", () => {
  test("a grep of the logs and crash files for fixture strings finds nothing", async () => {
    const { root, cleanup } = tempRoot("grep");
    cleanups.push(cleanup);
    const spacesRoot = join(root, "Tasks-Mira-Okafor-fixture");
    mkdirSync(spacesRoot);
    const seeded = await seedMira(spacesRoot, { tasks: 40 });
    const { texts, machine } = await spaceText(seeded.folder);
    expect(texts.length).toBeGreaterThan(40);

    // The service's machine is the space's authority, so the space opens for writing.
    const home = join(root, "h");
    mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
    const machineName = "mira-fixture-desktop";
    writeFileSync(
      join(stateOf(home), "machine.json"),
      JSON.stringify({
        machine_id: machine,
        name: machineName,
        created_at: "2026-11-13T08:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const env = {
      TTASKS_TICKET: "Q4M8-fixture-ticket-secret",
      TTASKS_TASK: "M-14 fixture task marker",
      CODEX_THREAD_ID: "019a-fixture-thread",
      CLAUDE_CODE_SESSION_ID: "fixture-session-7d2c",
      TTASKS_SPACE: "fixture-space-marker",
    };
    const crashText = texts.find((t) => t.length > 12) ?? "Fix appointment time zones";

    // Start, open the space and take its daily backup, serve a client and refuse a wrong key,
    // refuse a second start, crash, recover, stop.
    const first = services.start(home, { spaces: [seeded.folder], env });
    const firstJson = await waitReady(home, first.pid);
    runtimeDirs.push(firstJson);
    const opened = await waitFor(
      () => readLog(home).find((e) => e["ev"] === "space.open"),
      READY_MS,
      "the space opens",
    );
    expect(opened["migrated"]).toBe(false);
    expect(
      await waitFor(
        () => readLog(home).find((e) => e["ev"] === "space.maintained"),
        READY_MS,
        "the space's upkeep",
      ),
    ).toMatchObject({ backup: "taken" });
    const path = firstJson.endpoint?.path ?? "";
    expect(await endpointInstance(home, path)).toBe(firstJson.instance);
    await expect(
      openRpc({
        path,
        key: Buffer.alloc(32, 7),
        client: {
          kind: "cli",
          version: "0.0.0-test",
          build: "test",
          pid: process.pid,
          package: null,
          tty: { stdin: false, stdout: false },
        },
        context: { env },
      }),
    ).rejects.toMatchObject({ reason: "untrusted_endpoint" });
    await waitFor(
      () => readLog(home).find((e) => e["ev"] === "local.handshake_failed"),
      READY_MS,
      "the refused handshake is logged",
    );
    const second = services.start(home, { spaces: [seeded.folder], env });
    expect((await within(second.exit, EXIT_MS, "second start")).code).toBe(EXIT.locked);
    first.send(`crash ${crashText}`);
    expect((await within(first.exit, EXIT_MS, "crash")).code).toBe(EXIT.crashed);
    const again = services.start(home, { spaces: [seeded.folder], env });
    runtimeDirs.push(await waitReady(home, again.pid));
    await waitFor(
      () => readLog(home).filter((e) => e["ev"] === "space.open").length === 2 || undefined,
      READY_MS,
      "the space opens again",
    );
    again.send("stop");
    expect((await within(again.exit, EXIT_MS, "stop")).code).toBe(EXIT.ok);

    const files = diagnostics(home);
    const names = files.map((f) => f.file);
    expect(names).toContain("logs/service.log");
    expect(names.filter((n) => n.startsWith("crash/"))).toHaveLength(1);
    const events = readLog(home).map((e) => e["ev"]);
    for (const ev of ["service.locked", "service.crashed", "space.open", "space.closed"]) {
      expect(events).toContain(ev);
    }

    const needles = [
      ...texts.filter((t) => t.length >= 4),
      crashText,
      seeded.folder,
      spacesRoot,
      "Tasks-Mira-Okafor-fixture",
      root,
      home,
      stateOf(home),
      readFileSync(join(stateOf(home), "ipc.key"), "utf8"),
      machineName,
      ...Object.values(env),
      ...(hostname().length >= 6 ? [hostname()] : []),
    ];
    const hits: string[] = [];
    for (const { file, text } of files) {
      for (const needle of needles) {
        for (const form of forms(needle)) {
          if (form !== "" && text.includes(form)) hits.push(`${file}: ${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  }, 180_000);
});
