// @vitest-environment happy-dom
//
// The sidebar's folded areas (folds.ts): kept for the browser per space, back after a reload, and
// what is read back is checked, so anything else stored there unfolds nothing and breaks nothing.
import { PRODUCT_ID } from "@tasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import { keepFolds, readFolds } from "./folds.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.3.web.folds] folded areas are kept per space for the browser, and only area IDs are read back", () => {
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
});
