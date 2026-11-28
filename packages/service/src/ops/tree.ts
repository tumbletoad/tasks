// A tree space's calls (`backendOf`): each entry of a family moved to the tree becomes one named
// command of the tree's writer, and its answer is built from what that command did. The writer
// keeps that answer in its receipt, so a retry under the same request ID is answered from it
// without a read first. Only test and trial spaces are trees until the switch; an entry whose
// family has not moved yet is refused on them.
import { AppError, type AnyEntry } from "@ttasks/contracts";
import type {
  Id,
  SpaceWriterHandle,
  TreeRequest,
  TreeResult,
  WorkerConnection,
  WriteResult,
} from "@ttasks/storage";
import type { Caller, Principal } from "./caller.ts";
import { resultFailure, spaceUnavailable, storageFailure } from "./errors.ts";
import { checkGrant, type HomeGate } from "./grant.ts";
import type { SessionPort } from "./binding.ts";

/** A space as a tree entry reads and writes it (handlers.ts `ServedSpace`). */
export interface TreeSpace {
  readonly id: string;
  readonly state: string;
  readonly writer: SpaceWriterHandle | undefined;
  readonly reader: WorkerConnection | undefined;
}

/** What a tree entry is given: the call after the contract's rules, on a tree space. */
export interface TreeCall {
  readonly host: {
    readonly machine: { readonly id: string };
    readonly homes?: HomeGate;
    readonly sessions?: SessionPort;
  };
  readonly caller: Caller;
  readonly principal: Principal;
  readonly entry: AnyEntry;
  readonly space: TreeSpace;
  readonly input: Record<string, unknown>;
  readonly today: string;
}

type TreeEntry = (call: TreeCall) => Promise<unknown>;

/** Whether a space is served by a tree's writer. */
export const isTree = (space: Pick<TreeSpace, "writer">): boolean =>
  space.writer?.backend === "tree";

/** The entries moved to the tree, by name. */
const TREE_ENTRIES: Readonly<Record<string, TreeEntry>> = {};

/** The entry's tree handler, or a refusal: its family has not moved to the tree yet. */
export function treeEntry(name: string): TreeEntry {
  return (
    TREE_ENTRIES[name] ??
    (() =>
      Promise.reject(
        new AppError({
          code: "op_unknown",
          message: "This operation does not work on a tree space yet.",
          hint: "Use a space made before the tree, or wait for the step that moves it.",
        }),
      ))
  );
}

/** The space's reader, while it is served. */
export function treeReader(call: TreeCall): WorkerConnection {
  const reader = call.space.reader;
  if (reader === undefined) throw spaceUnavailable("not_served", false, call.space.state);
  return reader;
}

/**
 * Sends one named command for the call: the credential from the connection, the base and the
 * reason the caller gave, and the entry, so a refusal of the entry's own rules stores no receipt.
 * A refusal or a conflict becomes the entry's error, as today's writer's does.
 */
export async function submitTree(
  call: TreeCall,
  command: string,
  input: Record<string, unknown>,
  options: { readonly base?: string } = {},
): Promise<TreeResult> {
  const writer = call.space.writer;
  if (writer === undefined || call.space.state !== "open") {
    throw spaceUnavailable("not_served", false, call.space.state);
  }
  const { principal } = call;
  let result: TreeResult;
  try {
    checkGrant(call.host, call.caller, call.space.id);
    const principalId = await writer.actor(principal.actorKind, principal.label);
    const given = call.input["base"];
    const base = typeof given === "string" ? given : options.base;
    const reason = call.input["reason"];
    const request: TreeRequest = {
      space_id: writer.spaceId,
      request_id: String(call.input["request_id"]),
      actor: {
        scope_id: principal.scope,
        principal_id: principalId,
        actor_kind: principal.actorKind,
        machine_id: call.host.machine.id as Id<"m">,
        origin: principal.origin,
        ...(principal.session === undefined ? {} : { session_id: principal.session as Id<"se"> }),
        ...(principal.run === undefined ? {} : { run_id: principal.run as Id<"ru"> }),
      },
      ...(base === undefined ? {} : { base }),
      ...(typeof reason === "string" ? { reason } : {}),
      entry: call.entry.name,
      command,
      input,
    };
    checkGrant(call.host, call.caller, call.space.id);
    result = await writer.submitTree(request);
  } catch (error) {
    throw storageFailure(error);
  }
  if (result.status === "conflict" || result.status === "rejected") {
    throw resultFailure(asWriteResult(result), {}, undefined, principal.origin);
  }
  return result;
}

/**
 * A tree's refusal as today's writer's result carries one, for the one mapping of refusals to the
 * entries' errors: a node's change is a task's, as a task's row is today.
 */
function asWriteResult(result: TreeResult): WriteResult {
  return {
    ...result,
    conflicts: (result.conflicts ?? []).map((c) => ({
      ...c,
      entity: c.entity === "nodes" ? "tasks" : c.entity,
      at: c.at ?? 0,
    })),
    results: [],
  } as unknown as WriteResult;
}
