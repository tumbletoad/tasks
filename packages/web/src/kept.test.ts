// @vitest-environment happy-dom
//
// What a person typed, kept in the browser (kept.ts): back after a reload, kept for the tab when
// storage is blocked or full, listed per prefix, and another tab's change is heard.
import { PRODUCT_ID } from "@tasks/brand";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keep, keptNames, onKept, readKept, readKeptJson } from "./kept.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[A5.3.8.web.kept] typed text kept in the browser: back after a reload, and kept for the tab when storage fails", () => {
  test("kept under the product's prefix, listed by prefix, and removed", () => {
    keep("draft.sp_1.tk_1", "Ask Ana about the van");
    keep("draft.sp_1.tk_2", "Second");
    keep("draft.sp_2.tk_1", "Other space");
    expect(localStorage.getItem(`${PRODUCT_ID}.draft.sp_1.tk_1`)).toBe("Ask Ana about the van");
    expect(readKept("draft.sp_1.tk_1")).toBe("Ask Ana about the van");
    expect(keptNames("draft.sp_1.").sort()).toEqual(["draft.sp_1.tk_1", "draft.sp_1.tk_2"]);
    keep("draft.sp_1.tk_1", undefined);
    expect(readKept("draft.sp_1.tk_1")).toBeUndefined();
    expect(keptNames("draft.sp_1.")).toEqual(["draft.sp_1.tk_2"]);
    localStorage.setItem(`${PRODUCT_ID}.top.sp_1`, "{not json");
    expect(readKeptJson("top.sp_1")).toBeUndefined();
  });

  test("storage that is full or blocked keeps the text for the tab's life", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    keep("draft.sp_1.tk_9", "Still here");
    expect(readKept("draft.sp_1.tk_9")).toBe("Still here");
    expect(keptNames("draft.sp_1.")).toEqual(["draft.sp_1.tk_9"]);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    keep("draft.sp_1.tk_9", undefined);
    expect(readKept("draft.sp_1.tk_9")).toBeUndefined();
    expect(keptNames("draft.sp_1.")).toEqual([]);
    vi.restoreAllMocks();
    // Storage works again: its value is the one read.
    keep("draft.sp_1.tk_9", "Back in storage");
    expect(localStorage.getItem(`${PRODUCT_ID}.draft.sp_1.tk_9`)).toBe("Back in storage");
    expect(readKept("draft.sp_1.tk_9")).toBe("Back in storage");
  });

  test("another tab's change is heard by its name, and only by its name", () => {
    const heard: (string | undefined)[] = [];
    const stop = onKept("draft.sp_1.tk_1", (value) => heard.push(value));
    const event = (key: string | null, newValue: string | null) =>
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    event(`${PRODUCT_ID}.draft.sp_1.tk_1`, "From the other tab");
    event(`${PRODUCT_ID}.draft.sp_1.tk_2`, "Not this one");
    event(`${PRODUCT_ID}.draft.sp_1.tk_1`, null);
    stop();
    event(`${PRODUCT_ID}.draft.sp_1.tk_1`, "After");
    expect(heard).toEqual(["From the other tab", undefined]);
  });
});
