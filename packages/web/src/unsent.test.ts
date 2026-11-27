// @vitest-environment happy-dom
//
// The unsent words of a space (unsent.ts): a title being typed belongs to the tab that types it,
// and every kind is listed, let go and heard of in one way. Discard takes only the value it was
// shown, and a change made in another tab is heard as one made here.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { priorityChange, titleChange } from "./edit/change.ts";
import type { Unsaved } from "./edit/edits.ts";
import { browserKept } from "./kept.ts";
import {
  forgetTask,
  keepDraft,
  keepNote,
  keepTextDraft,
  keepTitleDraft,
  keptTitles,
  letGo,
  onUnsent,
  readTextDraft,
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
  test("a duplicated tab is a tab of its own: the original's reload finds its title and its refused edit, and a copy of the tab takes neither for its own", async () => {
    const typed = { typed: "Book the hall", title: "Book" };
    keepTitleDraft(SPACE, TASK, typed);
    const line = refused(priorityChange(1));
    unsavedKeeper(SPACE).save(keyed(line));

    // The tab's own reload: the page leaves, and the next one is the same tab.
    window.dispatchEvent(new Event("pagehide"));
    vi.resetModules();
    const reloaded = await import("./unsent.ts");
    expect(reloaded.readTitleDraft(SPACE, TASK)).toEqual(typed);
    expect(
      reloaded
        .unsavedKeeper(SPACE)
        .load()
        .map((u) => u.id),
    ).toEqual([line.id]);

    // Duplicated: the browser hands the copy the tab's own storage as it is while the page lives.
    vi.resetModules();
    const copy = await import("./unsent.ts");
    expect(copy.readTitleDraft(SPACE, TASK)).toBeUndefined();
    expect(copy.keptTitles(SPACE, TASK).map((kept) => kept.mine)).toEqual([false]);
    expect(copy.unsavedKeeper(SPACE).load()).toEqual([]);
    // What the copy keeps takes nothing of the original's away.
    copy.unsavedKeeper(SPACE).save(new Map());
    expect(
      reloaded
        .unsavedKeeper(SPACE)
        .load()
        .map((u) => u.id),
    ).toEqual([line.id]);
  });

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

  test("words typed in place of a summary, a context or an entry are listed with their part, let go only as shown, and forgotten with their task", () => {
    keepTextDraft(SPACE, TASK, "n3", { typed: "Call the landlord on Monday", before: "Call him" });
    keepTextDraft(SPACE, TASK, "context", { typed: "The flat has two rooms", before: "" });
    expect(readTextDraft(SPACE, TASK, "n3")?.typed).toBe("Call the landlord on Monday");
    const shown = unsentOf(SPACE).filter((word) => word.kind === "text");
    expect(shown.map((word) => [word.kind === "text" ? word.part : "", word.task])).toEqual([
      ["context", TASK],
      ["n3", TASK],
    ]);
    expect(listed()).toEqual(["text: Call the landlord on Monday", "text: The flat has two rooms"]);
    expect(unsentTasks(SPACE)).toEqual([TASK]);
    // Typed on before the Discard: the newer words stay.
    keepTextDraft(SPACE, TASK, "n3", { typed: "Call the landlord on Tuesday", before: "Call him" });
    for (const word of shown) letGo(SPACE, word);
    expect(listed()).toEqual(["text: Call the landlord on Tuesday"]);
    forgetTask(SPACE, TASK);
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
    for (const kind of ["draft", "note", "title", "text", "unsaved"]) {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `${PRODUCT_ID}.${kind}.${SPACE}.${TASK}`,
          newValue: "x",
          storageArea: localStorage,
        }),
      );
    }
    expect(heard).toBe(6);
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
