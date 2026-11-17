// @vitest-environment happy-dom
//
// What a task's composer sends and when its words count as gone (composer.ts): the words as typed,
// one request ID for one note across a reload, and a launch's words clear only once they reached
// the agent.
import { beforeEach, describe, expect, test } from "vitest";
import type { Receipt, ReceiptState } from "../api.ts";
import {
  carry,
  delivered,
  keepDraft,
  keepNote,
  readDraft,
  readNote,
  settled,
  wordsOf,
} from "./composer.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const ID = "0b6f7f3e-6a1c-4c55-9d3e-2f7f5f1d9a10";

const receipt = (id: string, state: ReceiptState, route = "terminal"): Receipt => ({
  id,
  reference: `ref-${id}`,
  instance: "claude",
  route,
  state,
  reason: null,
  at: {},
});

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.8.web.composer-sends] a composer sends what was typed once, and keeps it until it arrived", () => {
  test("the words are sent as typed: indents and inner lines stay, only blank lines around go", () => {
    expect(wordsOf("   ")).toBe("");
    expect(wordsOf("\n\n    indented()\n  more()\n\n")).toBe("    indented()\n  more()");
    expect(wordsOf("Ask Ana about the van  ")).toBe("Ask Ana about the van");
    expect(wordsOf("\r\n  x")).toBe("  x");
  });

  test("a note on its way keeps its request ID across a reload, and clearing the draft drops it", () => {
    keepDraft(SPACE, "tk_1", "Call the landlord");
    keepNote(SPACE, "tk_1", { words: "Call the landlord", id: ID });
    // A reload reads the same request back, so the same words are saved once.
    expect(readNote(SPACE, "tk_1")).toEqual({ words: "Call the landlord", id: ID });
    expect(readNote(SPACE, "tk_2")).toBeUndefined();
    keepDraft(SPACE, "tk_1", "");
    expect(readDraft(SPACE, "tk_1")).toBe("");
    expect(readNote(SPACE, "tk_1")).toBeUndefined();
    // What is read back is checked by its shape.
    keepNote(SPACE, "tk_1", { words: "x", id: "not an id" });
    expect(readNote(SPACE, "tk_1")).toBeUndefined();
  });

  test("a launch's words count as gone once the agent has them, and stay when it failed", () => {
    expect(delivered(receipt("a", "prepared"))).toBeUndefined();
    expect(delivered(receipt("a", "dispatching"))).toBeUndefined();
    // A terminal has the words once the agent started; a link or the clipboard hands them over.
    expect(delivered(receipt("a", "dispatched"))).toBeUndefined();
    expect(delivered(receipt("a", "dispatched", "link"))).toBe(true);
    expect(delivered(receipt("a", "confirmed"))).toBe(true);
    expect(delivered(receipt("a", "failed"))).toBe(false);
    expect(delivered(receipt("a", "unknown"))).toBe(false);

    carry(SPACE, "tk_1", "l1", "Compare the listings");
    carry(SPACE, "tk_1", "l2", "Book the van");
    expect(
      settled(SPACE, "tk_1", [receipt("l1", "prepared"), receipt("l2", "dispatched")]),
    ).toEqual([]);
    // Another task's receipts settle nothing here.
    expect(settled(SPACE, "tk_2", [receipt("l1", "confirmed")])).toEqual([]);
    expect(settled(SPACE, "tk_1", [receipt("l1", "failed"), receipt("l2", "confirmed")])).toEqual([
      "Book the van",
    ]);
    // Each launch settles once.
    expect(
      settled(SPACE, "tk_1", [receipt("l1", "confirmed"), receipt("l2", "confirmed")]),
    ).toEqual([]);
  });
});
