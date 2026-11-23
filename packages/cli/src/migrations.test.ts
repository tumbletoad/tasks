import { CLI_NAME } from "@ttasks/brand";
import { describe, expect, test } from "vitest";
import { migratedLine } from "./migrations.ts";

const MIGRATED = {
  from: "0.1",
  to: "0.5",
  at: "2026-10-01T09:00:00.000Z",
  backup: "pre-migrate-20261001T085959.000Z-e1-s12",
};

describe("[A2.3.1.hub.migration-timeout] what the space list says a migration did", () => {
  test("it sends the person to the backup from before it only while that backup is there", () => {
    expect(migratedLine({ ...MIGRATED, backup_listed: true })).toContain(
      `${MIGRATED.backup} (${CLI_NAME} space backups lists it).`,
    );
    // An older service says nothing of it: the line stays as it was.
    expect(migratedLine(MIGRATED)).toContain(`${CLI_NAME} space backups lists it`);
    const gone = migratedLine({ ...MIGRATED, backup_listed: false });
    expect(gone).toMatch(/The backup taken just before it was pre-migrate-\S+\.$/);
    expect(gone).not.toContain("space backups");
  });
});
