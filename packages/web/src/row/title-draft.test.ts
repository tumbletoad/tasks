// @vitest-environment happy-dom
//
// A title being typed belongs to the tab that types it (title-draft.ts): another tab's words are
// listed as theirs, and this tab neither takes nor lets go of them by its own editing.
import { beforeEach, describe, expect, test } from "vitest";
import { browserKept } from "../kept.ts";
import {
  discardTitleDraft,
  forgetTitleDrafts,
  keepTitleDraft,
  keptTitles,
  readTitleDraft,
  titleDraftTasks,
} from "./title-draft.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const TASK = "t_0123456789abcdefghjkmnpqrs";

/** What another tab of this browser keeps, as it writes it. */
const otherTab = (tab: string, typed: string) => {
  browserKept.keep(`title.${SPACE}.${TASK}.${tab}`, JSON.stringify({ typed, title: "Book" }));
};

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.while-away.web.title-tabs] each tab keeps the title it types", () => {
  test("this tab reads and lets go of its own words only; another tab's are listed as theirs until the person discards them", () => {
    otherTab("othertab", "Book the hall in April");
    expect(readTitleDraft(SPACE, TASK)).toBeUndefined();
    keepTitleDraft(SPACE, TASK, { typed: "Book the hall", title: "Book" });
    expect(readTitleDraft(SPACE, TASK)?.typed).toBe("Book the hall");
    expect(keptTitles(SPACE, TASK).map((k) => [k.draft.typed, k.mine])).toEqual([
      ["Book the hall", true],
      ["Book the hall in April", false],
    ]);
    // Escape or a save here lets go of this tab's words, never the other tab's.
    keepTitleDraft(SPACE, TASK, undefined);
    expect(keptTitles(SPACE, TASK).map((k) => k.draft.typed)).toEqual(["Book the hall in April"]);
    expect(titleDraftTasks(SPACE)).toEqual([TASK]);
    discardTitleDraft(SPACE, TASK, "othertab");
    expect(keptTitles(SPACE, TASK)).toEqual([]);
    // A task gone for good takes every tab's words with it.
    otherTab("one", "x");
    otherTab("two", "y");
    forgetTitleDrafts(SPACE, TASK);
    expect(titleDraftTasks(SPACE)).toEqual([]);
  });
});
