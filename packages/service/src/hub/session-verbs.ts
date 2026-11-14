// `tasks session` (A3 3.7.3 "Rebinding", M4.06): the user ends, unbinds or rebinds an agent
// session. Session records live in machine state until a schema step adds A1's `sessions` table
// (binding/sessions.ts), so these are the service's own methods, like `tasks space` and `tasks
// roots`, and only a person at a terminal may call them (the UI reaches the same Bindings methods
// once its session list exists). With the table they become the user-only `session.unbind`,
// `session.rebind` and `session.end` operations through the writer; this module and the CLI keep
// their shape.
//
//   session/end    { session }         its connections say their session ended (`lost`)
//   session/unbind { session }         its connections go on unbound
//   session/rebind { session, task }   a new session on another task of its space takes its place
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { isId } from "@tasks/storage";
import type { Bindings, SessionChange } from "../binding/index.ts";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass, opCall, type OpsHost } from "../ops/index.ts";

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

export interface SessionVerbsHost {
  readonly bindings: Bindings;
  readonly ops: OpsHost;
}

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can do this.",
      hint: `Ask the user to do this in ${PRODUCT_NAME}.`,
      data: { rule: "user_only" },
    });
  }
}

const sessionIn = (params: JsonObject): string => {
  const session = params["session"];
  if (!isId(session, "se")) throw invalid("session", "Expected a session ID (se_...)");
  return session;
};

const notFound = (): AppError =>
  new AppError({
    code: "not_found",
    message: "No session on this machine has this ID.",
    hint: `Its task lists its sessions: ${CLI_NAME} show <task> --section sessions`,
  });

/** What a change did, as the method answers it: IDs and words only. */
function answer(change: SessionChange, done: "ended" | "unbound" | "rebound"): JsonObject {
  switch (change.kind) {
    case "not_found":
      throw notFound();
    case "ended":
      throw new AppError({
        code: "invalid_input",
        message: "This session has ended.",
        hint: "Open the task again to start a new session.",
        data: { issues: [{ path: "session", message: "The session has ended" }] },
      });
    case "no_change":
      return { session: change.session, result: "no_change" };
    case "changed":
      return {
        session: change.session,
        result: done,
        ...(change.next === undefined ? {} : { next: change.next }),
      };
  }
}

export function sessionVerbs(host: SessionVerbsHost): Readonly<Record<string, Verb>> {
  return {
    "session/end": (params, cls) => {
      userOnly(cls);
      return Promise.resolve(answer(host.bindings.end(sessionIn(params)), "ended"));
    },
    "session/unbind": (params, cls) => {
      userOnly(cls);
      return Promise.resolve(answer(host.bindings.unbind(sessionIn(params)), "unbound"));
    },
    "session/rebind": async (params, cls) => {
      userOnly(cls);
      const id = sessionIn(params);
      const task = params["task"];
      if (typeof task !== "string" || task === "" || task.length > 64) {
        throw invalid("task", "Expected a task reference, such as M-14");
      }
      const session = host.bindings.session(id);
      if (session === undefined) throw notFound();
      // The task as the user reads it, in the session's space: a session never changes space
      // (A3 3.7.8), so a task of another space is not found there.
      const read = (await opCall(
        host.ops,
        { class: cls, env: {} },
        { op: "task.get", space: session.space, input: { task, sections: ["outcome"] } },
      )) as { task: { id: string; ref: string } };
      return { ...answer(host.bindings.rebind(id, read.task.id), "rebound"), task: read.task.ref };
    },
  };
}
