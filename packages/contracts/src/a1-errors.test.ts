// Storage's error codes mapped onto the registry's. Storage's own test checks
// that every code it can raise is in the table (packages/storage/test/errors.test.ts).
import { describe, expect, test } from "vitest";
import { A1_ERRORS, a1ErrorBody, a1Mapping, type A1ErrorMapping } from "./a1-errors.ts";
import { ERROR_CODES, isErrorCode } from "./errors.ts";

/** The write path's codes, HAS_ACTIVE_TASKS and SPACE_READ_ONLY among them. */
const A1_3_7 = [
  "VALIDATION_FAILED",
  "TOO_LARGE",
  "NOT_FOUND",
  "DELETED",
  "SPACE_MISMATCH",
  "AMBIGUOUS_REFERENCE",
  "VERSION_CONFLICT",
  "BASE_REQUIRED",
  "BASE_FROM_FUTURE",
  "EPOCH_CHANGED",
  "INVALID_TRANSITION",
  "REQUEST_ID_REUSED",
  "REQUEST_ID_INVALID",
  "UNDO_CONFLICT",
  "NOTHING_TO_UNDO",
  "NOTHING_TO_REDO",
  "UNDO_BEFORE_FLOOR",
  "HAS_ACTIVE_TASKS",
  "PLACE_OUTSIDE_ROOTS",
  "SPACE_READ_ONLY",
  "BACKUP_FAILED",
  "STORAGE_BUSY",
  "STORAGE_OVERLOADED",
  "DURABILITY_FAILED",
];

const mappings = Object.entries(A1_ERRORS) as [string, A1ErrorMapping][];

describe("[A3.3.5.error-map] A1's codes map onto the registry's, with A1's code as the cause", () => {
  test("every code of A1 3.7 is mapped, onto a code of the catalogue", () => {
    for (const code of A1_3_7) expect(Object.hasOwn(A1_ERRORS, code), code).toBe(true);
    for (const [cause, mapping] of mappings) {
      expect(isErrorCode(mapping.code), cause).toBe(true);
      expect(cause).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("a reason and a retry rule come only with the codes that carry them (A3 3.5)", () => {
    for (const [cause, mapping] of mappings) {
      const carries = mapping.code === "space_unavailable" || mapping.code === "read_only";
      if (!carries) {
        expect(mapping.reason, cause).toBeUndefined();
        expect(mapping.retryable, cause).toBeUndefined();
        continue;
      }
      expect(typeof mapping.retryable, cause).toBe("boolean");
      if (mapping.code === "space_unavailable") expect(mapping.reason, cause).toMatch(/^[a-z_]+$/);
      // A read-only space is no transport hiccup: retrying never helps.
      if (mapping.code === "read_only") expect(mapping.retryable, cause).toBe(false);
    }
    // The ones A3 names: a retry with the same request_id is safe.
    for (const cause of ["STORAGE_BUSY", "STORAGE_OVERLOADED", "STORAGE_TIMEOUT"]) {
      expect(a1Mapping(cause)).toMatchObject({ code: "space_unavailable", retryable: true });
    }
    expect(a1Mapping("STORAGE_WORKER_FAILED")).toMatchObject({ reason: "restarting" });
  });

  test("the conflict family: stale bases, a missing base and a reused request ID", () => {
    for (const cause of ["VERSION_CONFLICT", "BASE_REQUIRED", "EPOCH_CHANGED"]) {
      expect(a1Mapping(cause).code, cause).toBe("conflict");
    }
    expect(a1Mapping("REQUEST_ID_REUSED").code).toBe("request_id_conflict");
    expect(ERROR_CODES.request_id_conflict.class).toBe("conflict");
    // Another space's prefix is not_found, never a task elsewhere.
    expect(a1Mapping("SPACE_MISMATCH").code).toBe("not_found");
  });

  test("the error body keeps A1's code in data.cause and only where the problem lies", () => {
    expect(
      a1ErrorBody("NOT_FOUND", "No task has this reference", { op: 1, field: "task" }),
    ).toEqual({
      code: "not_found",
      message: "No task has this reference",
      data: { cause: "NOT_FOUND", op: 1, field: "task" },
    });
    expect(a1ErrorBody("STORAGE_TIMEOUT", "No answer in time")).toEqual({
      code: "space_unavailable",
      message: "No answer in time",
      data: { cause: "STORAGE_TIMEOUT", reason: "timeout", retryable: true },
    });
    // A reused request ID carries the time of the original.
    expect(
      a1ErrorBody("REQUEST_ID_REUSED", "Used for another change", {
        field: "request_id",
        at: Date.UTC(2026, 10, 12, 9),
      }).data,
    ).toEqual({
      cause: "REQUEST_ID_REUSED",
      field: "request_id",
      original_at: "2026-11-12T09:00:00.000Z",
    });
    // SPACE_READ_ONLY carries the writer's reason (read_only names the reason), which
    // replaces a mapping's own. Only a reason-shaped word passes, and only for the codes that
    // carry a reason, so no value reaches the body this way.
    expect(
      a1ErrorBody("SPACE_READ_ONLY", "Not the authority", { reason: "not_authority" }),
    ).toEqual({
      code: "read_only",
      message: "Not the authority",
      data: { cause: "SPACE_READ_ONLY", reason: "not_authority", retryable: false },
    });
    expect(a1ErrorBody("STORAGE_BUSY", "Busy", { reason: "held" }).data).toMatchObject({
      reason: "held",
    });
    for (const reason of ["Not the authority", "", "x".repeat(41), "a-b", "M-14"]) {
      expect(a1ErrorBody("SPACE_READ_ONLY", "Read only", { reason }).data, reason).toEqual({
        cause: "SPACE_READ_ONLY",
        retryable: false,
      });
    }
    expect(a1ErrorBody("NOT_FOUND", "No task", { reason: "held" }).data).toEqual({
      cause: "NOT_FOUND",
    });
    // A code this build does not know is a bug.
    expect(a1ErrorBody("SOMETHING_NEW", "Unknown").code).toBe("internal");
    expect(a1Mapping("toString").code).toBe("internal");
  });
});
