import { afterEach, describe, expect, test } from "vitest";
import { tempRoot } from "../../test/harness.ts";
import { DurableGrants } from "../http/grants.ts";
import type { ServiceDb } from "../http/service-db.ts";
import type { FeedHub } from "../http/ws.ts";
import type { Grant } from "../local/index.ts";
import type { OpsHost } from "../ops/index.ts";
import { PHONE_CALLS } from "./allowed.ts";
import { EDIT_SCOPES, LinkService, RUN_SCOPE } from "./service.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const call = (path: string) => {
  const found = PHONE_CALLS[path];
  if (found === undefined) throw new Error(path);
  return found;
};

describe("[S5.link.answers] a phone sees what its screens use, and nothing of this computer", () => {
  test("a task's folder, a launch's request, a note's launches and the person's skills stay out", () => {
    const seen = call("/api/v1/op/task.get").output({
      view: "digest",
      as_of: { seq: 1 },
      bound: true,
      request: { note: "n1", text: "Fixture request" },
      task: {
        id: "tk_1",
        ref: "M-1",
        title: "Fixture",
        folder: { path: "~/work/fixture", of: "task", repo: "fixture" },
        notes: [
          {
            ref: "n1",
            text: "Fixture note",
            request_for: [{ launch: "LABCDE", instance: "codex" }],
          },
        ],
      },
      skills: [{ name: "fixture-skill", text: "Fixture skill text" }],
      skills_unread: 2,
    });
    const text = JSON.stringify(seen);
    for (const kept of ["Fixture", "Fixture note", "M-1"]) expect(text).toContain(kept);
    for (const gone of ["folder", "~/work", "request", "skill", "codex", "bound"]) {
      expect(text).not.toContain(gone);
    }
  });

  test("a run watched shows its state and answer, never its agent app's key or its cleanup", () => {
    const run = {
      id: "ru_1",
      instance: "codex-home",
      state: "working",
      reason: null,
      queued_at: 1,
      started_at: 2,
      ended_at: null,
      asked: "Fixture",
      cleanup: "process group ended",
      error: "Fixture error from this machine",
      answer: "Fixture answer",
      answer_final: false,
      answer_cut: false,
      version: 3,
    };
    for (const path of ["/api/v1/launch/runs", "/api/v1/launch/run", "/api/v1/launch/stop"]) {
      const seen = JSON.stringify(
        call(path).output(path.endsWith("runs") ? { runs: [run] } : { run }),
      );
      expect(seen).toContain("Fixture answer");
      expect(seen).not.toContain("codex-home");
      expect(seen).not.toContain("cleanup");
      expect(seen).not.toContain("this machine");
    }
  });

  test("a capture sends a task's own fields only: no folder, source or log", () => {
    const check = call("/api/v1/op/task.add").check;
    expect(
      check?.({ tasks: [{ title: "Fixture", due: "2026-12-01", project: "Garden" }] }),
    ).toBeUndefined();
    expect(check?.({ tasks: [{ title: "Fixture", folder: "~/work" }] })).toBe("tasks[].folder");
    expect(check?.({ tasks: [{ title: "Fixture", sources: [] }] })).toBe("tasks[].sources");
    expect(call("/api/v1/op/page.read").check?.({ target: "space" })).toBe("target");
    expect(call("/api/v1/op/page.read").check?.({ target: "M-180" })).toBeUndefined();
  });
});

describe("[S5.link.saved] Remove and the Run switch answer once they are saved", () => {
  async function linked() {
    let fail = false;
    const fake = {
      grants: () => Promise.resolve([]),
      dropGrants: () => Promise.resolve(),
      putGrants: () => (fail ? Promise.reject(new Error("disk")) : Promise.resolve()),
    } as unknown as ServiceDb;
    const grants = await DurableGrants.open(fake);
    const temp = tempRoot("link-saved");
    cleanups.push(temp.cleanup);
    const link = new LinkService({
      stateDir: temp.root,
      grants,
      ops: { spaces: () => [] } as unknown as OpsHost,
      feed: {} as FeedHub,
      launches: {} as never,
      log: () => undefined,
      now: Date.now,
      host: "127.0.0.1",
      ports: [0],
    });
    cleanups.push(() => void link.close());
    const { grant } = grants.create({
      kind: "device",
      principal: "user",
      spaces: ["sp_a"],
      scopes: [...EDIT_SCOPES],
      attrs: { key: "fixture-pin" },
    });
    await grants.flush();
    return {
      link,
      grants,
      phone: grant.grant_id,
      failing: (on: boolean) => {
        fail = on;
      },
    };
  }

  const row = (grants: DurableGrants, id: string): Grant | undefined => grants.get(id);

  test("a Remove that is not saved says so, holds at once, and is saved by Remove again", async () => {
    const { link, grants, phone, failing } = await linked();
    failing(true);
    await expect(link.remove({ phone })).rejects.toMatchObject({
      code: "service_unavailable",
      data: { reason: "not_saved", retryable: true },
    });
    expect(row(grants, phone)?.revoked_at).not.toBeNull();
    expect(link.view({}).phones).toEqual([expect.objectContaining({ id: phone, removing: true })]);
    failing(false);
    expect(await link.remove({ phone })).toEqual({ removed: true });
    expect(link.view({}).phones).toEqual([]);
  });

  test("Run on that is not saved stays off; Run off that is not saved holds at once", async () => {
    const { link, grants, phone, failing } = await linked();
    failing(true);
    await expect(link.rights({ phone, run: true })).rejects.toMatchObject({
      data: { reason: "not_saved" },
    });
    expect(row(grants, phone)?.scopes).not.toContain(RUN_SCOPE);
    failing(false);
    expect(await link.rights({ phone, run: true })).toEqual({ run: true });
    expect(row(grants, phone)?.scopes).toContain(RUN_SCOPE);
    failing(true);
    await expect(link.rights({ phone, run: false })).rejects.toMatchObject({
      data: { reason: "not_saved" },
    });
    expect(row(grants, phone)?.scopes).not.toContain(RUN_SCOPE);
    failing(false);
    expect(await link.rights({ phone, run: false })).toEqual({ run: false });
  });
});
