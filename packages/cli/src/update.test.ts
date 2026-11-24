// What a person reads at the end of `ttasks update`, and doctor's spaces row: a space less usable
// than before is named in the service's own words, with its backup and the way back, and the
// update exits 8; spaces as before get one line.
import { CLI_NAME } from "@ttasks/brand";
import { describe, expect, test } from "vitest";
import type { SpaceCompared } from "@ttasks/service/version-update";
import { spacesCheck } from "./doctor.ts";
import { spaceLines } from "./update.ts";

const FAILED =
  "The update of this space from schema 3 to 4 failed (BACKUP_FAILED): nothing in it changed. The backup taken before it: fixture-barrier.sqlite.";
const SINCE = Date.parse("2026-11-24T08:00:00.000Z");

const space = (
  name: string,
  verdict: SpaceCompared["verdict"],
  before: string,
  after: SpaceCompared["after"],
): SpaceCompared => ({ id: `sp_${name}`, name, verdict, before: { state: before }, after });

describe("[A2.3.12.6.update.spaces] the end of an update that restarted the service", () => {
  test("a space less usable than before gets the service's words, its migration and backup, and the way back", () => {
    const end = spaceLines(
      {
        boundMs: 120_000,
        spaces: [
          space("Work", "worse", "open", {
            state: "read_only",
            reason: "migration_failed",
            message: FAILED,
          }),
          space("Home", "worse", "open", {
            state: "unavailable",
            reason: "open_failed",
            message: "The space could not be opened.",
            migrated: {
              from: "0.3",
              to: "0.4",
              at: "2026-11-24T08:00:05.000Z",
              backup: "pre-migrate-fixture",
              backup_listed: true,
            },
          }),
          space("Notes", "as_before", "open", { state: "open" }),
          space("Big", "unsettled", "open", { state: "opening" }),
        ],
      },
      { from: "0.1.0" },
      SINCE,
    );
    expect(end.worse).toBe(true);
    expect(end.lines).toEqual([
      `Work was open for changes before the update and is read-only now. ${FAILED}`,
      expect.stringMatching(
        /^Home was open for changes before the update and is unavailable now\. The space could not be opened\. Updated from schema 0\.3 to 0\.4 on .*pre-migrate-fixture/,
      ),
      `Big had not finished opening 2 minutes after the restart, perhaps behind a migration. ${CLI_NAME} space list shows how it opened.`,
      "The other space is as usable as before.",
      `To go back to 0.1.0: ${CLI_NAME} update --rollback`,
    ]);
  });

  test("spaces as before get one line, with what a migration did; one that did not open in time alone is no reason to go back", () => {
    const same = spaceLines(
      {
        boundMs: 120_000,
        spaces: [
          space("Notes", "as_before", "open", {
            state: "open",
            migrated: { from: "0.3", to: "0.4", at: "2026-11-24T08:00:05.000Z" },
          }),
          space("Copy", "as_before", "read_only", { state: "read_only" }),
        ],
      },
      { from: "0.1.0" },
      SINCE,
    );
    expect(same.worse).toBe(false);
    expect(same.lines).toEqual([
      expect.stringMatching(/^Notes: Updated from schema 0\.3 to 0\.4 on /),
      "The 2 spaces are as usable as before.",
    ]);
    const slow = spaceLines(
      { boundMs: 120_000, spaces: [space("Big", "unsettled", "open", undefined)] },
      { from: "0.1.0" },
      SINCE,
    );
    expect(slow.worse).toBe(true);
    expect(slow.lines.some((line) => line.includes("--rollback"))).toBe(false);
  });

  test("doctor warns about a space read-only because its migration failed, and not about a restored copy", () => {
    const failed = spacesCheck(
      [
        {
          entry: 0,
          name: "Work",
          state: "read_only",
          reason: "migration_failed",
          message: FAILED,
        },
      ],
      SINCE,
    );
    expect(failed.status).toBe("warn");
    expect(failed.detail).toContain(`Work: read_only (migration_failed). ${FAILED}`);
    const copy = spacesCheck(
      [{ entry: 0, name: "Copy", state: "read_only", reason: "read_only_copy" }],
      SINCE,
    );
    expect(copy.status).toBe("ok");
  });
});
