// An install that finds the data folder of a build from before the rename says so, so the spaces
// in it do not look lost.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CLI_NAME, EARLIER_DATA_FOLDER } from "@ttasks/brand";
import { earlierDataNotice, makesDataFolder } from "../src/install.ts";

const home = mkdtempSync(join(tmpdir(), "ttasks-earlier-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const facts = () =>
  process.platform === "win32"
    ? { platform: "win32" as const, env: { USERPROFILE: home }, accountHome: undefined, uid: 0 }
    : { platform: process.platform, env: {}, accountHome: home, uid: 501 };

describe("[A2.3.12.4.install.earlier-folder] an install names an earlier build's data folder", () => {
  test("the install that makes the data folder names an earlier one, says it stays untouched, and gives no command", () => {
    expect(earlierDataNotice(facts(), true)).toBeUndefined();
    const earlier = join(home, EARLIER_DATA_FOLDER);
    mkdirSync(join(earlier, "spaces"), { recursive: true });
    const notice = earlierDataNotice(facts(), true) ?? "";
    expect(notice).toContain(earlier);
    expect(notice).toMatch(/does not use that folder and leaves it untouched/);
    expect(notice).not.toContain(`${CLI_NAME} `);
  });

  test("says nothing to a person whose data folder of this version already existed", () => {
    mkdirSync(join(home, EARLIER_DATA_FOLDER), { recursive: true });
    expect(earlierDataNotice(facts(), false)).toBeUndefined();
  });

  test("a separate install makes its data folder when the script made its root in this run", () => {
    const root = join(home, "separate");
    mkdirSync(root);
    const separate = { data: root, home: root };
    expect(makesDataFolder(separate, [".", "versions", "home.marker"])).toBe(true);
    expect(makesDataFolder(separate, ["versions/0.2.0"])).toBe(false);
    const daily = { data: join(home, "daily-data"), home: undefined };
    expect(makesDataFolder(daily, [])).toBe(true);
    mkdirSync(daily.data);
    expect(makesDataFolder(daily, ["."])).toBe(false);
  });
});
