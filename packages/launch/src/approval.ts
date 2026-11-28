// Approval of definitions that arrive with data. A space may carry a custom target
// definition or a routine: executable intent that another machine, an import or a copy can plant.
// Each machine pins what its person allowed by a content hash in machine.toml `[approvals]`:
//
//   1. SHA-256 over the canonical JSON of the definition, with its reference-only keys removed.
//   2. Without a matching `allow` the item needs approval on this machine; a matching `deny` keeps
//      it off without asking again.
//   3. Any change to the content changes the hash, so the item is disabled again. One byte is
//      enough: strings are hashed as they are, with no Unicode normalisation or trimming.
//
// Canonical JSON is RFC 8785 (JCS) for the values a definition holds: object keys sorted by UTF-16
// code units, no whitespace, strings and numbers as ECMAScript's JSON.stringify writes them. A
// value JSON cannot carry exactly (undefined, a function, a bigint, NaN, Infinity, a Date, a class
// instance) is refused rather than dropped, so two different definitions never share a form.
//
// The hash input starts with a domain line and the kind (`tasks-approval/1`, `custom_target`), so
// a routine's hash can never approve a target definition with the same JSON, or the reverse.
//
// Approving is a user-only operation: the UI session or an interactive CLI writes
// the verdict through the service's machine.toml editor. Nothing here writes.
import { createHash } from "node:crypto";
import { APPROVAL_KEY, type Verdict } from "./sections.ts";

export const APPROVAL_KINDS = ["custom_target", "routine"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * Keys that only refer to the record that carries the definition, never to what it runs: storage
 * bookkeeping. Everything else is content and part of the hash.
 */
export const REFERENCE_KEYS: Readonly<Record<ApprovalKind, readonly string[]>> = {
  custom_target: ["space_id", "created_at", "updated_at", "seq", "rev"],
  // A routine's hash covers an explicit projection (routineApproval below).
  routine: [],
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A value that has no exact canonical JSON form. */
export class NotCanonical extends Error {
  override readonly name = "NotCanonical";
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** RFC 8785 canonical JSON of `value`. Throws NotCanonical for a value JSON cannot carry exactly. */
/** A string as JCS writes it; a lone surrogate has no UTF-8 form and is refused (RFC 8785 3.2.2.2). */
function stringJson(text: string): string {
  if (!text.isWellFormed()) throw new NotCanonical("a string with a lone surrogate");
  return JSON.stringify(text);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return stringJson(value);
    case "number":
      if (!Number.isFinite(value)) throw new NotCanonical("a number that is not finite");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value as unknown[];
        // A hole is no element (`map` skips it): [,] would read as [].
        for (let i = 0; i < items.length; i += 1) {
          if (!(i in items)) throw new NotCanonical("an array with a hole");
        }
        return `[${items.map((item) => canonicalJson(item)).join(",")}]`;
      }
      if (!isPlainObject(value)) throw new NotCanonical("an object that is not plain data");
      const record = value as Record<string, unknown>;
      // Sorted by UTF-16 code units, as JCS says: the default sort compares exactly those.
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${stringJson(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    default:
      throw new NotCanonical(`a ${typeof value} value`);
  }
}

/** The definition without its reference-only keys (top level only). */
export function approvalContent(kind: ApprovalKind, definition: unknown): unknown {
  // Checked before the reference keys are removed: the copy below would turn any object (a Date,
  // a Map) into a plain one, and so into another definition's form.
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition) ||
    !isPlainObject(definition)
  ) {
    throw new NotCanonical("a definition must be a plain object");
  }
  const drop = new Set(REFERENCE_KEYS[kind]);
  return Object.fromEntries(
    Object.entries(definition as Record<string, unknown>).filter(([k]) => !drop.has(k)),
  );
}

// Fixed, not the product's identifier: machine.toml pins approvals by this hash, so a new domain
// would disable every approved definition.
const DOMAIN = "tasks-approval/1";

/** The approval key of a definition: `sha256-<64 hex>`, as `[approvals]` stores it. */
export function approvalHash(kind: ApprovalKind, definition: unknown): string {
  const canonical = canonicalJson(approvalContent(kind, definition));
  const digest = createHash("sha256").update(`${DOMAIN}\n${kind}\n${canonical}`, "utf8").digest();
  return `sha256-${digest.toString("hex")}`;
}

/**
 * The content a routine's approval covers: its template, its parameters, the instance
 * it runs in and that instance's run permission at approval time. A raised permission changes the
 * hash, so the routine asks again.
 */
export function routineApproval(
  routine: {
    readonly template: string;
    readonly params: Readonly<Record<string, string>>;
    readonly instance_id: string;
  },
  runPermission: string,
): JsonValue {
  return {
    template: routine.template,
    params: { ...routine.params },
    instance_id: routine.instance_id,
    run_permission: runPermission,
  };
}

export type ApprovalState = "approved" | "denied" | "needs_approval";

/**
 * Whether this machine allows the definition: `approved` only for an exact `allow` of its current
 * hash. A definition that cannot be hashed needs approval, which it can never get.
 */
export function approvalState(
  kind: ApprovalKind,
  definition: unknown,
  approvals: ReadonlyMap<string, Verdict>,
): ApprovalState {
  let hash: string;
  try {
    hash = approvalHash(kind, definition);
  } catch (error) {
    if (error instanceof NotCanonical) return "needs_approval";
    throw error;
  }
  if (!APPROVAL_KEY.test(hash)) return "needs_approval";
  const verdict = approvals.get(hash);
  if (verdict === "allow") return "approved";
  if (verdict === "deny") return "denied";
  return "needs_approval";
}
