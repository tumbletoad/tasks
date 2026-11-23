// @vitest-environment happy-dom
//
// The unsent words of a space (unsent.ts): a title being typed belongs to the tab that types it,
// and every kind is listed, let go and heard of in one way. Discard takes only the value it was
// shown, and a change made in another tab is heard as one made here.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import { priorityChange, titleChange } from "./edit/change.ts";
import type { Unsaved } from "./edit/edits.ts";
import { browserKept } from "./kept.ts";
import {
  forgetTask,
  keepDraft,
  keepNote,
  keepTitleDraft,
  keptTitles,
  letGo,
  onUnsent,
  readTitleDraft,
  unsavedKeeper,
  unsentOf,
  unsentTasks,
} from "./unsent.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const TASK = "t_0123456789abcdefghjkmnpqrs";
const NOTE = "0b6f7f3e-6a1c-4c55-9d3e-2f7f5f1d9a10";

/** What another tab of this browser keeps, as it writes it. */
const otherTab = (tab: string, typed: string, task = TASK) => {
  browserKept.keep(`title.${SPACE}.${task}.${tab}`, JSON.stringify({ typed, title: "Book" }));
};

/** A refused edit of the task, as the edits hand it to the keeper. */
const refused = (change: ReturnType<typeof titleChange>, task = TASK): Unsaved => ({
  id: crypto.randomUUID(),
  task,
  ref: "M-1",
  field: change.fields[0] ?? "title",
  change,
  reason: "failed",
});

const keyed = (unsaved: Unsaved) => new Map([[`${unsaved.task}\u0000${unsaved.field}`, unsaved]]);

/** The listed words as kind and text, in a fixed order. */
const listed = () =>
  unsentOf(SPACE)
    .map((word) => `${word.kind}: ${word.kind === "edit" ? JSON.stringify(word.shown) : word.text}`)
    .sort();

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
    expect(unsentTasks(SPACE)).toEqual([TASK]);
    letGo(SPACE, { kind: "title", task: TASK, tab: "othertab", text: "Book the hall in April" });
    expect(keptTitles(SPACE, TASK)).toEqual([]);
    // A name that is no task's at all takes every tab's words with it.
    otherTab("one", "x");
    otherTab("two", "y");
    forgetTask(SPACE, TASK);
    expect(unsentTasks(SPACE)).toEqual([]);
  });
});

describe("[A5.trash.web.unsent] every unsent word goes through one module", () => {
  test("it lists every kind with its task and exact value, and Discard of an older value leaves the newer one another tab kept, of every kind", () => {
    keepDraft(SPACE, TASK, "Ask about the deposit");
    keepNote(SPACE, TASK, { words: "Call the landlord", id: NOTE });
    otherTab("othertab", "Book the hall in April");
    unsavedKeeper(SPACE).save(keyed(refused(titleChange("Book the hall"))));
    const shown = unsentOf(SPACE);
    expect(listed()).toEqual([
      "draft: Ask about the deposit",
      'edit: "Book the hall"',
      "note: Call the landlord",
      "title: Book the hall in April",
    ]);
    expect(new Set(shown.map((word) => word.task))).toEqual(new Set([TASK]));

    // Another tab typed on before the person's Discard here.
    keepDraft(SPACE, TASK, "Ask about the deposit and the keys");
    otherTab("othertab", "Book the hall in May");
    unsavedKeeper(SPACE).save(keyed(refused(titleChange("Book the big hall"))));
    for (const word of shown) letGo(SPACE, word);
    expect(listed()).toEqual([
      "draft: Ask about the deposit and the keys",
      'edit: "Book the big hall"',
      "title: Book the hall in May",
    ]);
    // Discard of what is shown now takes it.
    for (const word of unsentOf(SPACE)) letGo(SPACE, word);
    expect(unsentOf(SPACE)).toEqual([]);
  });

  test("a change of any kind, made here or in another tab, is heard; a kept edit let go anywhere is told to the tab that kept it", () => {
    let heard = 0;
    const stop = onUnsent(() => {
      heard += 1;
    });
    keepDraft(SPACE, TASK, "Ask about the deposit");
    expect(heard).toBe(1);
    // Another tab keeps each kind: the storage event is all this tab gets.
    for (const kind of ["draft", "note", "title", "unsaved"]) {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `${PRODUCT_ID}.${kind}.${SPACE}.${TASK}`,
          newValue: "x",
          storageArea: localStorage,
        }),
      );
    }
    expect(heard).toBe(5);
    stop();

    // This tab kept an edit; the foot of the Trash, or another tab, lets it go.
    const keeper = unsavedKeeper(SPACE);
    const gone: Unsaved[] = [];
    const quiet = keeper.onGone((line) => gone.push(line));
    const line = refused(priorityChange(1));
    keeper.save(keyed(line));
    for (const word of unsentOf(SPACE).filter((each) => each.kind === "edit")) letGo(SPACE, word);
    expect(gone).toEqual([line]);
    quiet();
  });
});
