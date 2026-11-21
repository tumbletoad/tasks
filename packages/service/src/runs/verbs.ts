// `ttasks run` (runs/*): a person starts a background run of a task, sees the runs and their state,
// reads an answer and stops a run. Starting is a person's own (the connection classes allow it for
// an interactive command only): a run may change anything the person's agent setup allows, without
// asking.
import { RPC_ERROR, RpcError, type JsonObject } from "@ttasks/bridge/protocol";
import { AppError, RequestId } from "@ttasks/contracts";
import { RUN_REQUEST_MAX_BYTES, type RunRecord } from "@ttasks/contracts/runs";
import type { ConnectionClass } from "../local/index.ts";
import type { ServedSpace } from "../ops/index.ts";
import type { RunService } from "./service.ts";

export interface RunVerbsHost {
  readonly runs: RunService;
  /** The space a person's call means: the one it names, else the machine's default. */
  space(named: string | undefined): ServedSpace;
}

/** A run as `ttasks run` shows it: codes and the person's own task text, never a folder. */
export function runView(run: RunRecord, task: string | null, waiting?: string): JsonObject {
  const result = run.result;
  return {
    id: run.id,
    task,
    instance: run.instance,
    state: run.state,
    reason: run.reason,
    ...(waiting === undefined ? {} : { waiting }),
    queued_at: run.queuedAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    ...(run.request === null ? {} : { request: run.request }),
    ...(result === null
      ? {}
      : {
          outcome: result.outcome,
          ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
          ...(result.error === null ? {} : { error: result.error }),
          ...(result.nativeId === null ? {} : { native_id: result.nativeId }),
        }),
  };
}

const text = (params: JsonObject, key: string): string | undefined => {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new RpcError(RPC_ERROR.invalidParams, `${key} is a text`);
  }
  return value;
};

const RUN_ID = /^ru_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

const runId = (params: JsonObject): string => {
  const id = text(params, "run");
  if (id === undefined || !RUN_ID.test(id)) {
    throw new AppError({ code: "invalid_input", message: "Not a run ID.", data: { field: "run" } });
  }
  return id;
};

const noRun = (): AppError =>
  new AppError({ code: "not_found", message: "No run has this ID in this space." });

export function runVerbs(
  host: RunVerbsHost,
): Readonly<Record<string, (params: JsonObject, cls: ConnectionClass) => Promise<unknown>>> {
  return {
    "runs/start": async (params) => {
      const served = host.space(text(params, "space"));
      const task = text(params, "task");
      const requestId = params["request_id"];
      if (
        task === undefined ||
        typeof requestId !== "string" ||
        !RequestId.safeParse(requestId).success
      ) {
        throw new RpcError(RPC_ERROR.invalidParams, "task and request_id are required");
      }
      const request = text(params, "request") ?? null;
      if (request !== null && Buffer.byteLength(request, "utf8") > RUN_REQUEST_MAX_BYTES) {
        throw new AppError({
          code: "too_large",
          message: "The request is longer than a note may be.",
          data: { field: "request" },
        });
      }
      const instance = text(params, "instance");
      const run = await host.runs.queueTask(served.id ?? "", {
        task,
        ...(instance === undefined ? {} : { instance }),
        request,
        requestId,
      });
      const shown = await host.runs.show(served.id ?? "", run.id);
      return runView(shown?.run ?? run, shown?.task ?? null, host.runs.waiting(run.id));
    },
    "runs/list": async (params) => {
      const served = host.space(text(params, "space"));
      const listed = await host.runs.list(served.id ?? "", text(params, "task"));
      return {
        runs: listed.map(({ run, task }) => runView(run, task, host.runs.waiting(run.id))),
      };
    },
    "runs/show": async (params) => {
      const served = host.space(text(params, "space"));
      const shown = await host.runs.show(served.id ?? "", runId(params));
      if (shown === undefined) throw noRun();
      return {
        ...runView(shown.run, shown.task, host.runs.waiting(shown.run.id)),
        answer: shown.answer,
        answer_final: shown.run.result?.textFinal === true,
      };
    },
    "runs/stop": async (params) => {
      const served = host.space(text(params, "space"));
      const id = runId(params);
      const after = await host.runs.stop(served.id ?? "", id);
      if (after === undefined) throw noRun();
      const shown = await host.runs.show(served.id ?? "", id);
      return runView(shown?.run ?? after, shown?.task ?? null);
    },
  };
}
