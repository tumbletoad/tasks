// What a person reads at the end of `ttasks update`, and doctor's spaces row: a space that is not
// usable now is named in the service's own words, which name its backup, with the way back, and
// the update exits 8; the others get one line; a service that stopped answering is not checked, and
// one that is not running is named without a flag.
import { CLI_NAME } from "@ttasks/brand";
import { describe, expect, test } from "vitest";
import type { SpaceAtEnd, SpaceNote, SpacesReport } from "@ttasks/service/version-update";
import { spacesCheck } from "./doctor.ts";
import { outcomeJson, spaceLines, spacesJson } from "./update.ts";

const FAILED =
  "Migration to 0.6 failed (STORAGE_SQL). Your data is unchanged. The space stays at 0.5. Backup: pre-migrate-fixture-b. It is tried again after an update, or now with: ttasks space open <folder> --retry-migration";
const MISSING =
  "There is no space in this folder now. If its drive is not connected, connect it, then run: ttasks space open <folder>.";
const SINCE = Date.parse("2026-11-24T08:00:00.000Z");

const failed: SpaceNote = {
  state: "read_only",
  reason: "migration_failed",
  message: FAILED,
  migration_backup: "pre-migrate-fixture-b",
};
const missing: SpaceNote = { state: "unavailable", reason: "missing", message: MISSING };
const open: SpaceNote = { state: "open" };

const space = (
  name: string,
  verdict: SpaceAtEnd["verdict"],
  now: SpaceNote | undefined,
  before: SpaceNote | undefined,
): SpaceAtEnd => ({ id: `sp_${name}`, name, verdict, now, before });

const report = (
  spaces: SpaceAtEnd[],
  more: Partial<Omit<SpacesReport, "spaces">> = {},
): SpacesReport => ({
  boundMs: 120_000,
  noted: true,
  service: "answered",
  wayBack: "0.1.0",
  spaces,
  ...more,
});

describe("[A2.3.12.6.update.spaces] the end of an update names each space that is not usable now", () => {
  test("with the note from before the switch: the service's words and backup, what did not open in time, the others in one line, and the way back", () => {
    const end = spaceLines(
      report([
        space("Work", "not_usable", failed, open),
        space("Home", "not_usable", missing, open),
        space("Notes", "usable", open, open),
        space("Away", "as_before", missing, missing),
        space("Big", "unsettled", { state: "opening" }, open),
      ]),
    );
    expect(end.flagged).toBe(true);
    expect(end.lines).toEqual([
      `Work was open for changes before the update and is read-only now. ${FAILED}`,
      `Home was open for changes before the update and is unavailable now. ${MISSING}`,
      `Big had not finished opening within 2 minutes, perhaps behind a migration. ${CLI_NAME} space list shows how it opened.`,
      "The other 2 spaces are as usable as before.",
      `To go back to 0.1.0: ${CLI_NAME} update --rollback`,
    ]);
    expect(end.commands).toEqual([`${CLI_NAME} space list`, `${CLI_NAME} update --rollback`]);
  });

  test("without a note (a retry, a repair): a space may have been so before, except one whose migration this version tried", () => {
    const end = spaceLines(
      report(
        [
          space("Work", "not_usable", failed, undefined),
          space("Home", "not_usable", missing, undefined),
          space("Notes", "usable", open, undefined),
        ],
        { noted: false },
      ),
    );
    expect(end.lines).toEqual([
      `Work is read-only now. ${FAILED}`,
      `Home is unavailable now, as it may have been before this update. ${MISSING}`,
      "The other space is usable.",
      `To go back to 0.1.0: ${CLI_NAME} update --rollback`,
    ]);
    const fine = spaceLines(report([space("Notes", "usable", open, open)]));
    expect(fine).toEqual({
      lines: ["The space is as usable as before."],
      flagged: false,
      commands: [],
    });
  });

  test("a service that stopped answering leaves the spaces not checked: what it said last and where to look again, never as usable as before", () => {
    const end = spaceLines(
      report(
        [
          space("Work", "usable", open, open),
          space("Big", "unsettled", { state: "opening" }, open),
        ],
        { service: "stopped_answering" },
      ),
    );
    expect(end.flagged).toBe(true);
    expect(end.lines).toEqual([
      `The service stopped answering while the update waited for the spaces, so they could not be checked. What it said last: Work open for changes; Big still opening. To look again: ${CLI_NAME} doctor and ${CLI_NAME} space list`,
    ]);
    expect(end.commands).toEqual([`${CLI_NAME} doctor`, `${CLI_NAME} space list`]);
  });

  test("a service that is not running at the end: the spaces were not checked, how to look once it runs, and nothing flagged", () => {
    const end = spaceLines(report([], { service: "not_running", noted: false }));
    expect(end.flagged).toBe(false);
    expect(end.lines).toEqual([
      `The service is not running, so the spaces were not checked. Once it runs (${CLI_NAME} service start): ${CLI_NAME} doctor and ${CLI_NAME} space list show how they opened.`,
    ]);
    expect(end.commands).toEqual([
      `${CLI_NAME} service start`,
      `${CLI_NAME} doctor`,
      `${CLI_NAME} space list`,
    ]);
  });

  test("--json of a repair that left the service on an older version names that version, and that the restart waits for its next start", () => {
    expect(
      outcomeJson({
        outcome: "repaired",
        repair: { kind: "nothing" },
        current: "0.2.0",
        running: "0.1.0",
      }),
    ).toEqual({
      outcome: "repaired",
      repair: "nothing",
      current: "0.2.0",
      running: "0.1.0",
      restart: "deferred",
    });
    expect(
      outcomeJson({ outcome: "repaired", repair: { kind: "nothing" }, current: "0.2.0" }),
    ).toEqual({ outcome: "repaired", repair: "nothing", current: "0.2.0" });
  });

  test("--json has the same facts: each verdict with the service's reason, words and backup, the bound and the commands", () => {
    const spaces = report([space("Work", "not_usable", failed, open)]);
    expect(spacesJson(spaces, spaceLines(spaces).commands)).toEqual({
      service: "answered",
      noted: true,
      bound_ms: 120_000,
      way_back: "0.1.0",
      commands: [`${CLI_NAME} update --rollback`],
      spaces: [
        {
          id: "sp_Work",
          name: "Work",
          verdict: "not_usable",
          now: {
            state: "read_only",
            reason: "migration_failed",
            message: FAILED,
            backup: "pre-migrate-fixture-b",
          },
          before: { state: "open" },
        },
      ],
    });
  });

  test("doctor warns about a space read-only because its migration failed, and not about a restored copy", () => {
    const warned = spacesCheck(
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
    expect(warned.status).toBe("warn");
    expect(warned.detail).toContain(`Work: read_only (migration_failed). ${FAILED}`);
    const copy = spacesCheck(
      [{ entry: 0, name: "Copy", state: "read_only", reason: "read_only_copy" }],
      SINCE,
    );
    expect(copy.status).toBe("ok");
  });
});

describe("[A1.5.backup.old-move] doctor names old backups that stay in a space's own folder", () => {
  test("a space whose old backups stay is a warning, with the service's words", () => {
    const message = "Old backups stay in the space's own backups folder: 1 not whole.";
    const warned = spacesCheck(
      [{ entry: 0, name: "Work", state: "open", old_backups: { message } }],
      SINCE,
    );
    expect(warned.status).toBe("warn");
    expect(warned.detail).toContain(`Work: open. ${message}`);
    expect(spacesCheck([{ entry: 0, name: "Work", state: "open" }], SINCE).status).toBe("ok");
  });
});
