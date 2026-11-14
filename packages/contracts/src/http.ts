// The UI's HTTP rules (A3 3.2.2). The service's HTTP layer (A2) and the typed client share them.
import type { ErrorBody } from "./errors.ts";

/** Every entry with a UI face is `POST /api/v1/op/<name>`. */
export const HTTP_OP_PREFIX = "/api/v1/op/";

export function routePath(name: string): string {
  return `${HTTP_OP_PREFIX}${name}`;
}

/** The request body is the input JSON. A success is `200 {"result": ...}`. */
export interface HttpSuccess<T = unknown> {
  readonly result: T;
}

/** An error carries the status of its code (errors.ts). */
export interface HttpFailure {
  readonly error: ErrorBody;
}
