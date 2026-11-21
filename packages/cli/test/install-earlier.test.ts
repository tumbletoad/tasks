// An install that finds the data folder of a build from before the rename says so, so the spaces
// in it do not look lost.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CLI_NAME, EARLIER_DATA_FOLDER } from "@ttasks/brand";
import { earlierDataNotice } from "../src/install.ts";

const home = mkdtempSync(join(tmpdir(), "ttasks-earlier-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const facts = () =>
  process.platform === "win32"
    ? { platform: "win32" as const, env: { USERPROFILE: home }, accountHome: undefined, uid: 0 }
    : { platform: process.platform, env: {}, accountHome: home, uid: 501 };

describe("[A2.3.12.4.install.earlier-folder] an install names an earlier build's data folder", () => {
  test("says nothing without one, and names it and the way to its spaces with one", () => {
    expect(earlierDataNotice(facts())).toBeUndefined();
    const earlier = join(home, EARLIER_DATA_FOLDER);
    mkdirSync(join(earlier, "spaces"), { recursive: true });
    const notice = earlierDataNotice(facts()) ?? "";
    expect(notice).toContain(earlier);
    expect(notice).toContain(`${CLI_NAME} space open <its folder in ${join(earlier, "spaces")}>`);
  });
});
