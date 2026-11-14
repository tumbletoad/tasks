// Reading one JSON file of the prototype, bounded and total.

import { problem, type Problem } from "./problems.ts";
import { byteLength, decode, type Source } from "./text.ts";

export type JsonRead =
  | { readonly ok: true; readonly value: unknown; readonly problems: Problem[] }
  | { readonly ok: false; readonly problems: Problem[] };

/**
 * Parses a JSON file. Over `maxBytes` it is not read (`file-too-large`). Text that is no JSON gives
 * `json-invalid`, and the parser's own message is never kept, because it quotes the input.
 */
export function readJson(source: Source, file: string, maxBytes: number): JsonRead {
  if (byteLength(source) > maxBytes) {
    return { ok: false, problems: [problem("file-too-large", { file })] };
  }
  const { text, problems } = decode(source, file);
  try {
    return { ok: true, value: JSON.parse(text) as unknown, problems };
  } catch {
    // SyntaxError, or a RangeError from very deep nesting.
    problems.push(problem("json-invalid", { file }));
    return { ok: false, problems };
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
