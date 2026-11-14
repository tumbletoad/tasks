// Facts-only logging for lab run A (M0.09). Nothing the lab prints or writes may carry what a CLI,
// a model or the OS said in its own words: an account or user name, a path, an e-mail address or
// a credential can hide in any of them, and "local only" or truncation does not remove it. So a
// failure is reported as a class from a fixed set, and every program's top-level boundary prints
// only that class.

/** An error of the lab itself. Its code is a fixed phrase written in the lab's source. */
export class LabError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "LabError";
  }
}

const NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "SystemError",
]);

/**
 * A printable class for any thrown value: a lab error's (or a removal refusal's) fixed code, or
 * the error's constructor name from a fixed list plus a Node error code such as `ENOENT`. Never
 * the message, a path or a stack.
 */
export function errorLabel(error: unknown): string {
  if (error instanceof Error && (error.name === "LabError" || error.name === "ScratchRefusal")) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9 ',.-]{1,80}$/i.test(code)) return code;
  }
  if (!(error instanceof Error)) return "non-error value";
  const name = NAMES.has(error.name) ? error.name : "Error";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name;
}

/** A value kept only when it is one of `known`; anything else becomes "[other]". */
export const oneOf = (value: unknown, known: readonly string[]): string | null =>
  typeof value !== "string" ? null : known.includes(value) ? value : "[other]";

/** A finite number, or null. */
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
