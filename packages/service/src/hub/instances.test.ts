// The service's side of `tasks setup instances` (A4 3.2, A2 3.2.4): only the user's class writes,
// an entry machine.toml's reader would drop is refused before anything is written, an ID the
// machine has is refused, the record comes first and goes with the entry, and the live instances
// are the file's as written. Against a temporary config and state folder, without a service.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Instance } from "@tasks/launch";
import { makeDir } from "./files.ts";
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
    // Keys this command never writes, a target it does not write, the hand-made entry's ID.
    for (const entry of [
      codex({ open_permission: "full" }),
      codex({ target: "t3" }),
      codex({ id: "manual" }),
    ]) {
      await expect(add({ entries: [entry] }, "cli-interactive")).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(existsSync(toml)).toBe(false);
    expect(existsSync(join(h.stateDir, INSTANCES_RECORD))).toBe(false);

    writeFileSync(toml, "# mine\n[http]\nport = 7713\n");
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
