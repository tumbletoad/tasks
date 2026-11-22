// A home for a real service process with one space from machine.toml (A2 3.2.4): Mira,
// prefix M, created with this home's machine as its authority, so the service opens it for
// writing; and the agent homes its bridges name, registered with that service. For the tests that
// drive the MCP endpoint through real bridge processes. Tests only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSpace, newId } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { READY_MS, readLog, readServiceJson, registerSpaces, stateOf, waitFor } from "./harness.ts";
import { grantHome } from "./ops-helpers.ts";

/** Creates the space in `<home>/spaces/mira` and registers it in `<home>/config/machine.toml`. */
export async function hubSpace(
  home: string,
): Promise<{ readonly id: string; readonly folder: string }> {
  const machine = newId("m");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-13T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(home, "spaces"), { recursive: true });
  const space = createSpace(await checkedDriver(), join(home, "spaces", "mira"), {
    name: "Mira",
    ownerLabel: "Mira Okafor",
    machineId: machine,
    refPrefix: "M",
  });
  registerSpaces(home, [space.folder]);
  return { id: space.space.spaceId, folder: space.folder };
}

/**
 * Registers an agent home for `space` with the running service of `home`, as `ttasks setup agents
 * --apply` does (ops-helpers.ts `grantHome`), so a bridge whose entry names `instance` passes the
 * grant gate. A service run with its UI listener keeps the row in service.sqlite across restarts.
 */
export async function hubGrant(home: string, instance: string, space: string): Promise<string> {
  const path = readServiceJson(home)?.endpoint?.path;
  if (path === undefined) throw new Error("the service is not ready");
  return grantHome(home, path, { instance, space });
}

/** Waits until the services of `home` have opened its space `times` times in all. */
export const spaceOpen = (home: string, times = 1, ms = READY_MS): Promise<unknown> =>
  waitFor(
    () =>
      readLog(home).filter((event) => event["ev"] === "space.open").length >= times
        ? true
        : undefined,
    ms,
    "the space opens",
  );
