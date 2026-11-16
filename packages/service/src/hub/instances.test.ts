// The service's side of `tasks setup instances` (A4 3.2, A2 3.2.4): only the user's class writes,
// an entry machine.toml's reader would drop is refused before anything is written, an ID the
// machine has is refused, the record comes first and goes with the entry, and after every call,
// one that failed on a full disk included, the live instances are the file's. Against a temporary
// config and state folder, without a service.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Instance } from "@tasks/launch";
import { makeDir } from "./files.ts";

/**
 * A full disk, injected: the writes, in order, each named by its file's name with whether it
 * fails (ENOSPC, before anything reaches the disk). Writes past the list pass.
 */
const faults = vi.hoisted(() => ({ writes: [] as [string, "pass" | "fail"][] }));
vi.mock("./files.ts", async (importOriginal) => {
  const files = await importOriginal<typeof import("./files.ts")>();
  return {
    ...files,
    atomicWrite: (path: string, ...rest: unknown[]) => {
      const next = faults.writes.shift();
      if (next !== undefined) {
        if (!path.endsWith(next[0])) throw new Error(`expected a write of ${next[0]}`);
        if (next[1] === "fail") {
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        }
      }
      (files.atomicWrite as (path: string, ...rest: unknown[]) => void)(path, ...rest);
    },
  };
});
import { INSTANCES_RECORD, instanceVerbs, type InstancesHost } from "./instances.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tasks-instances-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function host(name: string): InstancesHost & { live: readonly Instance[]; events: string[] } {
  const configDir = join(root, name, "config");
  const stateDir = join(root, name, "state");
  makeDir(configDir, 0o700);
  makeDir(stateDir, 0o700);
  const made = {
    configDir,
    stateDir,
    platform: process.platform,
    live: [] as readonly Instance[],
    events: [] as string[],
    log: {
      log: (event: string) => {
        made.events.push(event);
      },
    } as unknown as InstancesHost["log"],
    set: (next: readonly Instance[]) => {
      made.live = next;
    },
  };
  return made;
}

const home = (folder: string) => join(root, "u", folder);
const codex = (extra: Record<string, unknown> = {}) => ({
  id: "codex",
  target: "codex-cli",
  label: "Codex",
  account: "default",
  exec: process.execPath,
  config_home: home(".codex"),
  remote_allowed: false,
  ...extra,
});

describe("[A4.3.2.setup.instances-service] the service writes and takes back [[instance]] entries", () => {
  test("only the user's class writes; a dropped entry or a taken ID writes nothing", async () => {
    const h = host("a");
    const verbs = instanceVerbs(h);
    const add = verbs["instances/add"];
    const remove = verbs["instances/remove"];
    if (add === undefined || remove === undefined) throw new Error("no verbs");
    const toml = join(h.configDir, "machine.toml");
    for (const cls of ["cli-script", "cli-agent", "bridge", "shim"] as const) {
      await expect(add({ entries: [codex()] }, cls)).rejects.toMatchObject({ code: "forbidden" });
      await expect(remove({}, cls)).rejects.toMatchObject({ code: "forbidden" });
    }
    // A relative home variable: the reader would drop the instance, so nothing is written.
    await expect(
      add({ entries: [codex({ env: { CODEX_HOME: "codex-b" } })] }, "cli-interactive"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Keys this command never writes, a T3 entry without its provider instance and model, T3's
    // keys on another target, the hand-made entry's ID.
    for (const entry of [
      codex({ open_permission: "full" }),
      codex({ target: "t3" }),
      codex({ target: "t3", t3_environment: "local", t3_provider_instance: "codex" }),
      codex({ t3_environment: "local", t3_provider_instance: "codex", t3_model: "m" }),
      codex({ id: "manual" }),
    ]) {
      await expect(add({ entries: [entry] }, "cli-interactive")).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(existsSync(toml)).toBe(false);
    expect(existsSync(join(h.stateDir, INSTANCES_RECORD))).toBe(false);

    // As the product makes it: 0600, whatever the umask (A2 3.2.2 rule 5).
    writeFileSync(toml, "# mine\n[http]\nport = 7713\n", { mode: 0o600 });
    expect(await add({ entries: [codex()] }, "cli-interactive")).toEqual({ added: ["codex"] });
    expect(h.live.map((i) => i.id)).toEqual(["codex"]);
    expect(readFileSync(toml, "utf8")).toMatch(
      /^# mine\n\[http\]\nport = 7713\n\n\[\[instance\]\]\nid = "codex"\n/u,
    );
    const record = JSON.parse(readFileSync(join(h.stateDir, INSTANCES_RECORD), "utf8")) as {
      instances: { id: string }[];
    };
    expect(record.instances.map((r) => r.id)).toEqual(["codex"]);
    await expect(add({ entries: [codex()] }, "cli-interactive")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "codex", result: "removed" }],
    });
    expect(readFileSync(toml, "utf8")).toBe("# mine\n[http]\nport = 7713\n");
    expect(h.live).toEqual([]);
    expect(h.events).toEqual(["config.instances_changed", "config.instances_changed"]);

    // A T3 instance as setup instances proposes it (A4 3.2): its provider instance and model.
    const t3 = {
      id: "t3-claude-second",
      target: "t3",
      label: "Claude Second",
      account: "second",
      t3_environment: "local",
      t3_provider_instance: "claude_second",
      t3_model: "claude-sonnet-5",
      remote_allowed: false,
    };
    expect(await add({ entries: [t3] }, "cli-interactive")).toEqual({
      added: ["t3-claude-second"],
    });
    expect(h.live.map((i) => [i.id, i.t3])).toEqual([
      [
        "t3-claude-second",
        { environment: "local", providerInstance: "claude_second", model: "claude-sonnet-5" },
      ],
    ]);
    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "t3-claude-second", result: "removed" }],
    });
    expect(readFileSync(toml, "utf8")).toBe("# mine\n[http]\nport = 7713\n");
  });

  test("an entry gone from the file loses its record; a damaged record changes nothing", async () => {
    const h = host("b");
    const verbs = instanceVerbs(h);
    const add = verbs["instances/add"];
    const remove = verbs["instances/remove"];
    if (add === undefined || remove === undefined) throw new Error("no verbs");
    await add({ entries: [codex()] }, "cli-interactive");
    const toml = join(h.configDir, "machine.toml");
    writeFileSync(toml, "");
    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "codex", result: "missing" }],
    });
    expect(await remove({}, "cli-interactive")).toEqual({ outcomes: [] });
    writeFileSync(join(h.stateDir, INSTANCES_RECORD), "{not json");
    await expect(add({ entries: [codex()] }, "cli-interactive")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(readFileSync(toml, "utf8")).toBe("");
  });
});

describe("[A4.3.2.setup.instances-follow] after any failure, Open offers what machine.toml holds", () => {
  const MINE = "# mine\n[http]\nport = 7713\n";
  const record = (h: InstancesHost) =>
    (
      JSON.parse(readFileSync(join(h.stateDir, INSTANCES_RECORD), "utf8")) as {
        instances: { id: string }[];
      }
    ).instances.map((r) => r.id);

  test("remove: the file is written, then the record's update fails; a retry ends consistent", async () => {
    const h = host("f1");
    const { "instances/add": add, "instances/remove": remove } = instanceVerbs(h);
    if (add === undefined || remove === undefined) throw new Error("no verbs");
    const toml = join(h.configDir, "machine.toml");
    writeFileSync(toml, MINE, { mode: 0o600 });
    await add({ entries: [codex()] }, "cli-interactive");
    expect(h.live.map((i) => i.id)).toEqual(["codex"]);

    faults.writes = [
      ["machine.toml", "pass"],
      [INSTANCES_RECORD, "fail"],
    ];
    await expect(remove({}, "cli-interactive")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(faults.writes).toEqual([]);
    // The block is out of the file, so Open no longer offers it, although the record still has it.
    expect(readFileSync(toml, "utf8")).toBe(MINE);
    expect(h.live).toEqual([]);
    expect(record(h)).toEqual(["codex"]);

    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "codex", result: "missing" }],
    });
    expect(record(h)).toEqual([]);
    expect(h.live).toEqual([]);
    expect(readFileSync(toml, "utf8")).toBe(MINE);
  });

  test("remove: an entry already gone from the file is dropped from what Open offers too", async () => {
    const h = host("f2");
    const { "instances/add": add, "instances/remove": remove } = instanceVerbs(h);
    if (add === undefined || remove === undefined) throw new Error("no verbs");
    const toml = join(h.configDir, "machine.toml");
    writeFileSync(toml, MINE, { mode: 0o600 });
    await add({ entries: [codex()] }, "cli-interactive");
    // The person takes the block out by hand while the service runs.
    writeFileSync(toml, MINE);
    expect(h.live.map((i) => i.id)).toEqual(["codex"]);
    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "codex", result: "missing" }],
    });
    expect(h.live).toEqual([]);
  });

  test("add: the record's write fails before the file is touched; nothing changes", async () => {
    const h = host("f3");
    const { "instances/add": add } = instanceVerbs(h);
    if (add === undefined) throw new Error("no verb");
    const toml = join(h.configDir, "machine.toml");
    writeFileSync(toml, MINE, { mode: 0o600 });
    faults.writes = [[INSTANCES_RECORD, "fail"]];
    await expect(add({ entries: [codex()] }, "cli-interactive")).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(faults.writes).toEqual([]);
    expect(readFileSync(toml, "utf8")).toBe(MINE);
    expect(h.live).toEqual([]);
    expect(existsSync(join(h.stateDir, INSTANCES_RECORD))).toBe(false);
    expect(await add({ entries: [codex()] }, "cli-interactive")).toEqual({ added: ["codex"] });
    expect(h.live.map((i) => i.id)).toEqual(["codex"]);
    expect(record(h)).toEqual(["codex"]);
  });

  test("add: the file's write fails and so does the record's take-back; a retry ends consistent", async () => {
    const h = host("f4");
    const { "instances/add": add, "instances/remove": remove } = instanceVerbs(h);
    if (add === undefined || remove === undefined) throw new Error("no verbs");
    const toml = join(h.configDir, "machine.toml");
    writeFileSync(toml, MINE, { mode: 0o600 });
    // The record is written, machine.toml's write fails, and the record's take-back fails too.
    faults.writes = [
      [INSTANCES_RECORD, "pass"],
      ["machine.toml", "fail"],
      [INSTANCES_RECORD, "fail"],
    ];
    await expect(add({ entries: [codex()] }, "cli-interactive")).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(faults.writes).toEqual([]);
    expect(readFileSync(toml, "utf8")).toBe(MINE);
    expect(h.live).toEqual([]);
    // The record names an entry the file lacks: harmless, a retry records it again.
    expect(record(h)).toEqual(["codex"]);
    expect(await add({ entries: [codex()] }, "cli-interactive")).toEqual({ added: ["codex"] });
    expect(h.live.map((i) => i.id)).toEqual(["codex"]);
    expect(record(h)).toEqual(["codex"]);
    expect(await remove({}, "cli-interactive")).toEqual({
      outcomes: [{ id: "codex", result: "removed" }],
    });
    expect(readFileSync(toml, "utf8")).toBe(MINE);
    expect(h.live).toEqual([]);
  });
});
