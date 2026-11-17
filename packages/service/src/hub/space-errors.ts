// A storage code from a space verb as A3's error body (A3 3.5's table). The worker threads
// hand over only the code, so the sentence is a fixed one per kind of failure.
import { PRODUCT_NAME } from "@tasks/brand";
import { a1ErrorBody, type ErrorBody } from "@tasks/contracts";

const MESSAGES: Readonly<Record<string, string>> = {
  SPACE_EXISTS: "A folder is already there.",
  SPACE_NOT_FOUND: "No space is there.",
  SPACE_PATH_INVALID: "That folder cannot hold a space.",
  // A backup of another space, or a folder that holds another space than its entry names.
  SPACE_ID_MISMATCH: "That holds another space than the one named.",
  SPACE_TOO_NEW: `The backup is from a newer ${PRODUCT_NAME}.`,
  BACKUP_INVALID: "The backup does not verify.",
  BACKUP_FAILED: "The backup or export failed. Nothing was changed.",
  BUNDLE_LIMIT_EXCEEDED: "The backup or bundle is over a size limit.",
  BUNDLE_INVALID: "The bundle is not a valid export of a space, or does not verify.",
  EXPORT_SECRET_FOUND: `A file of the space lies in ${PRODUCT_NAME}'s secrets folder. Nothing was exported.`,
  SPACE_SCHEMA_FOREIGN: `The space's database holds tables, indexes or views that ${PRODUCT_NAME} does not make, so a restore would refuse its bundle. Nothing was exported.`,
  SPACE_WRITER_TAKEN: "Another writer still holds the space.",
  SPACE_LOCKED_ELSEWHERE: "Another process holds the space.",
  SPACE_CHANGED: "The space changed meanwhile. Nothing was replaced.",
  STORAGE_MISUSE: "The space is not in a state for this.",
};

export function storageFailureBody(code: string | undefined): ErrorBody {
  const cause = code ?? "STORAGE_WORKER_FAILED";
  // A verb asked of a space in the wrong state (claim a space that is no copy, change one while
  // the service stops) is the caller's to fix, not a bug.
  if (cause === "STORAGE_MISUSE") {
    return {
      code: "invalid_input",
      message: MESSAGES[cause] ?? "",
      data: { cause, issues: [{ path: "space", message: "Not in a state for this" }] },
    };
  }
  return a1ErrorBody(cause, MESSAGES[cause] ?? `The space's storage failed (${cause}).`);
}
