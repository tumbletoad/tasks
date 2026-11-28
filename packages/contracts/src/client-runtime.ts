// The runtime behind the generated client (generated/client.ts). It loads no Zod, so the
// browser bundle stays small: the UI imports the types and trusts the service's validation.
import { AppError, isErrorCode } from "./errors.ts";
import { routePath } from "./http.ts";
import type { EntryName, InputOf, OutputOf } from "./registry.ts";

/**
 * Sends one POST with a JSON body and returns the status and the body text. The UI wraps `fetch`
 * and adds its token. Tests pass a fake.
 */
export interface ClientTransport {
  post(path: string, body: string): Promise<{ status: number; body: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A AppError from an error envelope, or `internal` when the reply is not one. */
function failure(status: number, payload: unknown): AppError {
  const error = isRecord(payload) ? payload["error"] : undefined;
  if (isRecord(error) && typeof error["message"] === "string") {
    const code = error["code"];
    const hint = error["hint"];
    const data = isRecord(error["data"]) ? error["data"] : {};
    return new AppError({
      code: isErrorCode(code) ? code : "internal",
      message: error["message"],
      ...(typeof hint === "string" ? { hint } : {}),
      data: isErrorCode(code) ? data : { ...data, cause: code },
    });
  }
  return new AppError({
    code: "internal",
    message: `The service answered with status ${String(status)} and no error body.`,
    data: { status },
  });
}

export type Caller = <N extends EntryName>(name: N, input: InputOf<N>) => Promise<OutputOf<N>>;

export function createCaller(transport: ClientTransport): Caller {
  return async (name, input) => {
    const reply = await transport.post(routePath(name), JSON.stringify(input));
    const payload = parse(reply.body);
    if (reply.status === 200 && isRecord(payload) && "result" in payload) {
      return payload["result"] as OutputOf<typeof name>;
    }
    throw failure(reply.status, payload);
  };
}
