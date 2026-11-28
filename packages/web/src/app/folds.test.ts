// @vitest-environment happy-dom
//
// The side menu's folds (folds.ts): kept for the browser per space, back after a reload, and what
// is read back is checked, so anything else stored there unfolds nothing and breaks nothing.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import { isFolded, keepFolds, readFolds, shownFolds, toggleFold } from "./folds.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.3.web.folds] folds are kept per space for the browser, and only IDs are read back", () => {
  test("kept per space, back after a reload, and removed once nothing is folded", () => {
    keepFolds("sp_1", new Set(["ar_lumen", "ar_home"]));
    keepFolds("sp_2", new Set(["ar_other"]));
    expect([...readFolds("sp_1")].sort()).toEqual(["ar_home", "ar_lumen"]);
    expect([...readFolds("sp_2")]).toEqual(["ar_other"]);
    keepFolds("sp_1", new Set());
    expect(localStorage.getItem(`${PRODUCT_ID}.folded.sp_1`)).toBeNull();
    expect(readFolds("sp_1").size).toBe(0);
  });

  test("anything else stored there folds nothing", () => {
    for (const value of ["{not json", '"ar_lumen"', '{"ar_lumen":true}', "null"]) {
      localStorage.setItem(`${PRODUCT_ID}.folded.sp_1`, value);
      expect(readFolds("sp_1").size, value).toBe(0);
    }
    localStorage.setItem(
      `${PRODUCT_ID}.folded.sp_1`,
      JSON.stringify(["ar_lumen", 7, "<img src=x>", "x".repeat(200)]),
    );
    expect([...readFolds("sp_1")]).toEqual(["ar_lumen"]);
  });

  test("a click keeps its own change only: another tab's fold since stays kept and does not move this tab", () => {
    expect(shownFolds("sp_tabs").size).toBe(0);
    // Another tab folds Home after this one loaded.
    keepFolds("sp_tabs", new Set(["ar_home"]));
    toggleFold("sp_tabs", "ar_work");
    expect([...shownFolds("sp_tabs")]).toEqual(["ar_work"]);
    expect([...readFolds("sp_tabs")].sort()).toEqual(["ar_home", "ar_work"]);
    toggleFold("sp_tabs", "ar_work");
    expect(shownFolds("sp_tabs").size).toBe(0);
    expect([...readFolds("sp_tabs")]).toEqual(["ar_home"]);
  });

  test("the first two levels start open and the deeper ones folded; a kept project is turned the other way", () => {
    const turned = new Set(["ar_work", "pj_portal"]);
    expect(isFolded(turned, "ar_home", 1)).toBe(false);
    expect(isFolded(turned, "ar_work", 1)).toBe(true);
    expect(isFolded(turned, "pj_lumen", 2)).toBe(false);
    expect(isFolded(turned, "pj_login", 3)).toBe(true);
    expect(isFolded(turned, "pj_portal", 3)).toBe(false);
    expect(isFolded(turned, "pj_deeper", 5)).toBe(true);
  });
});
