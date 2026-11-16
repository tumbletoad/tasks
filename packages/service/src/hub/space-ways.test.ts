import { CLI_NAME } from "@tasks/brand";
import { describe, expect, test } from "vitest";
import { SPACE_REASONS } from "./log.ts";
import { wayOutOf } from "./space-ways.ts";

/** Reasons whose open writes its own message, with its way out (spaces.ts). */
const OWN_MESSAGE = ["network_filesystem", "synced_folder", "check_failed", "migration_failed"];

describe("[A2.3.1.hub.space-way-out] every space that is not open for writing names its way out", () => {
  test("each reason has its own message or a way out; an open space has none", () => {
    for (const reason of SPACE_REASONS) {
      if (OWN_MESSAGE.includes(reason)) continue;
      const way = wayOutOf("unavailable", reason) ?? wayOutOf("read_only", reason);
      expect(way, reason).toBeDefined();
    }
    expect(wayOutOf("unavailable", "needs_recovery")).toContain(
      `${CLI_NAME} space recover <folder>`,
    );
    expect(wayOutOf("read_only", "read_only_copy")).toContain(`${CLI_NAME} space claim <folder>`);
    expect(wayOutOf("open", "needs_recovery")).toBeUndefined();
    expect(wayOutOf("opening", undefined)).toBeUndefined();
  });
});
