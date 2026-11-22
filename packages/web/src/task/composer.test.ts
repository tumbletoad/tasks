// @vitest-environment happy-dom
//
// What a task's composer sends and when its words count as gone (composer.ts): the words as typed,
// one request ID for one note across a reload, and an Open's words clear once they are on the task.
import { beforeEach, describe, expect, test } from "vitest";
import {
  keepDraft,
  keepNote,
  onSaved,
  readDraft,
  readNote,
  savedWords,
  wordsOf,
  type Saved,
} from "./composer.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const ID = "0b6f7f3e-6a1c-4c55-9d3e-2f7f5f1d9a10";

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

  test("words an Open saved on the task clear the kept draft and the field that shows them, unless the person typed on since; another task's are not touched", () => {
    const heard: Saved[] = [];
    const stop = onSaved((saved) => heard.push(saved));
    keepDraft(SPACE, "tk_1", "Compare the listings\n");
    keepDraft(SPACE, "tk_2", "Compare the listings");
    savedWords(SPACE, "tk_1", "Compare the listings");
    expect(readDraft(SPACE, "tk_1")).toBe("");
    expect(readDraft(SPACE, "tk_2")).toBe("Compare the listings");
    expect(heard).toEqual([{ space: SPACE, task: "tk_1", words: "Compare the listings" }]);
    // Typed on since the click: the draft stays.
    keepDraft(SPACE, "tk_1", "Compare the listings, then book the van");
    savedWords(SPACE, "tk_1", "Compare the listings");
    expect(readDraft(SPACE, "tk_1")).toBe("Compare the listings, then book the van");
    stop();
    savedWords(SPACE, "tk_2", "Compare the listings");
    expect(heard).toHaveLength(2);
  });
});
