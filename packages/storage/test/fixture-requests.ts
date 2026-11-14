// Write requests for the M1.06 fixtures, through the write path (M1.04). Plain functions without
// vitest, so a writer thread can use them too. Fixture text only.
import { newId, type Id } from "../src/ids.ts";
import type { Credential, WriteRequest } from "../src/write/request.ts";
import type { MachineInfo } from "../src/write/writer.ts";
import { TEST_MACHINE } from "./space-helpers.ts";

/** This machine in the fixtures: the authority of every fixture space. */
export const FIXTURE_MACHINE: MachineInfo = { id: TEST_MACHINE, name: "mira-desktop", os: "linux" };

/** The human owner's credential in a fixture space, as the CLI would send it. */
export function ownerCredential(owner: Id<"ac">, scope = "cli:fixture"): Credential {
  return {
    scope_id: scope,
    principal_id: owner,
    actor_kind: "human",
    machine_id: TEST_MACHINE,
    origin: "cli",
  };
}

/** A `task.create` request by `actor` with a fresh request ID. */
export function createRequest(spaceId: Id<"sp">, actor: Credential, title: string): WriteRequest {
  return {
    space_id: spaceId,
    request_id: `fixture-${newId("op").slice(3)}`,
    actor,
    ops: [{ kind: "task.create", title }],
  };
}
