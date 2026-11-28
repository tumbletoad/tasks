// @vitest-environment happy-dom
//
// A launch's request in the thread (Thread.tsx), rendered by React into happy-dom: the note the
// launch names shows in its session's entry as what the person asked, a launch that did not open
// offers to open again with it, a request whose session is not listed shows on its own as one, and
// a run that holds its agent's conversation offers Continue.
// Fixture data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Instance, Receipt, ReceiptState, Run } from "../api.ts";
import { I18n } from "../i18n/intl.tsx";
import type { DetailLog, DetailNote } from "./detail.ts";
import { Thread, type EntryEdit } from "./Thread.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: Instance = {
  key: "claude",
  app: "Claude Code",
  label: "Claude Code · work",
  glyph: "Cc",
  ring: 1,
  route: "terminal",
};

const AT = Date.UTC(2026, 10, 12, 10, 0);

function receipt(id: string, reference: string, state: ReceiptState, at: number): Receipt {
  return {
    id,
    reference,
    instance: "claude",
    route: "terminal",
    state,
    reason: state === "failed" ? "path_missing" : null,
    at: { prepared: at, ...(state === "prepared" ? {} : { [state]: at + 1_000 }) },
  };
}

function note(ref: string, text: string, launches: readonly string[], at = AT): DetailNote {
  return {
    kind: "note",
    ref,
    author: "user",
    at: new Date(at).toISOString(),
    text,
    forAgents: false,
    ...(launches.length === 0
      ? {}
      : { requestFor: launches.map((launch) => ({ launch, instance: "claude" })) }),
  };
}

let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

function render(
  notes: readonly DetailNote[],
  receipts: readonly Receipt[],
  onOpenAgain?: (note: DetailNote, instance: Instance) => void,
  taken: {
    removed?: readonly DetailNote[];
    onRemove?: (note: DetailNote) => void;
    log?: readonly DetailLog[];
    edit?: EntryEdit;
  } = {},
): void {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <I18n>
        <Thread
          notes={notes}
          log={[]}
          receipts={receipts}
          instances={[CLAUDE]}
          partial={false}
          {...(onOpenAgain === undefined ? {} : { onOpenAgain })}
          {...taken}
        />
      </I18n>,
    );
  });
}

const entries = () => [...host.querySelectorAll<HTMLElement>("[data-entry]")];
const askedIn = (entry: HTMLElement | undefined) =>
  entry?.querySelector("[data-part='asked']")?.textContent ?? undefined;

describe("[A5.3.9.web.thread-request] a launch's request shows in the thread as what the person asked its agent", () => {
  test("in its session's entry, from the click on, and not again as a note; gone with its note", () => {
    const asked = note("n2", "Check the clinic export first", ["L7KQ21"]);
    render([asked], [receipt("la_1", "L7KQ21", "prepared", AT)]);
    // Prepared says no state yet, but what was asked is there at once.
    expect(entries().map((e) => e.dataset["entry"])).toEqual(["session"]);
    expect(askedIn(entries()[0])).toBe("You asked: Check the clinic export first");

    render([asked], [receipt("la_1", "L7KQ21", "confirmed", AT)]);
    expect(entries()).toHaveLength(1);
    expect(askedIn(entries()[0])).toContain("Check the clinic export first");
    expect(entries()[0]?.textContent).toContain("Opened in Claude Code · work");
    expect(host.querySelector("[data-part='open-again']")).toBeNull();

    // The note was read before the launch was recorded: the receipt names it all the same.
    const early = note("n3", "Then fix the offset", []);
    render([early], [{ ...receipt("la_1", "L7KQ21", "dispatching", AT), request: "n3" }]);
    expect(entries().map((e) => e.dataset["entry"])).toEqual(["session"]);
    expect(askedIn(entries()[0])).toBe("You asked: Then fix the offset");

    // An undo took the note back: the session stays, without words.
    render([], [receipt("la_1", "L7KQ21", "confirmed", AT)]);
    expect(entries()).toHaveLength(1);
    expect(askedIn(entries()[0])).toBeUndefined();
  });

  test("a launch that did not open offers to open again with its request, on its newest launch only", () => {
    const asked = note("n2", "Check the clinic export first", ["L7KQ21", "L8MN32"]);
    const opened: [string, string][] = [];
    render(
      [asked],
      [receipt("la_1", "L7KQ21", "failed", AT), receipt("la_2", "L8MN32", "failed", AT + 60_000)],
      (n, instance) => opened.push([n.ref, instance.key]),
    );
    const again = [...host.querySelectorAll<HTMLButtonElement>("[data-part='open-again']")];
    expect(again).toHaveLength(1);
    expect(again[0]?.closest("[data-entry]")?.getAttribute("data-entry-key")).toBe("r:la_2");
    expect(again[0]?.getAttribute("aria-label")).toBe(
      "Open again with this request in Claude Code · work",
    );
    act(() => {
      again[0]?.click();
    });
    expect(opened).toEqual([["n2", "claude"]]);
  });

  test("a long request folds with More, so the launch's state and Open again stay in reach", () => {
    // happy-dom lays nothing out: a box with a long text is taller than it shows.
    const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent.length > 1_000 ? 2_000 : 0;
      },
    });
    try {
      const pasted = Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join("\n");
      render([note("n2", pasted, ["L7KQ21"])], [receipt("la_1", "L7KQ21", "failed", AT)], () => {
        /* opened */
      });
      const entry = entries()[0];
      const box = entry?.querySelector<HTMLElement>("[data-part='asked']");
      expect(box?.dataset["clamped"]).toBe("true");
      const more = entry?.querySelector<HTMLButtonElement>("button[aria-expanded]");
      expect(more?.getAttribute("aria-expanded")).toBe("false");
      expect(entry?.querySelector("[data-part='open-again']")).not.toBeNull();
      act(() => {
        more?.click();
      });
      expect(box?.dataset["clamped"]).toBe("false");

      // A short one has nothing to fold.
      render([note("n3", "Book the van", ["L7KQ22"])], [receipt("la_2", "L7KQ22", "failed", AT)]);
      expect(entries()[0]?.querySelector("button[aria-expanded]")).toBeNull();
    } finally {
      if (tall === undefined)
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      else Object.defineProperty(HTMLElement.prototype, "scrollHeight", tall);
    }
  });

  test("a request whose session is not listed shows on its own, as asked of its agent", () => {
    render([note("n1", "Plain note", []), note("n2", "Book the van", ["L7KQ21"], AT + 1)], []);
    const [plain, request] = entries();
    expect(plain?.textContent).not.toContain("asked");
    expect(request?.dataset["entry"]).toBe("note");
    expect(request?.textContent).toContain("asked Claude Code · work");
    expect(request?.textContent).toContain("Book the van");
  });
});

describe("[A4.3.4.1.t3.open] a T3 Code launch's entry brings its thread up in T3 Code", () => {
  test("Open in T3 on a thread T3 made, none on one that did not open; the two refusals T3 gives say why", () => {
    const t3 = (id: string, state: ReceiptState, reason: string | null = null): Receipt => ({
      ...receipt(id, `L${id.slice(-5).toUpperCase()}`, state, AT),
      instance: "t3",
      route: "t3-mcp",
      reason,
    });
    const asked: string[] = [];
    act(() => {
      root ??= createRoot(host);
      root.render(
        <I18n>
          <Thread
            notes={[]}
            log={[]}
            receipts={[
              t3("la_t3000", "confirmed"),
              t3("la_t3001", "failed", "model_unavailable"),
              t3("la_t3002", "failed", "pairing_denied"),
            ]}
            instances={[
              {
                key: "t3",
                app: "T3 Code",
                label: "T3 Code",
                glyph: "T3",
                ring: 2,
                route: "t3-mcp",
              },
            ]}
            partial={false}
            onOpenInT3={(launch) => asked.push(launch)}
          />
        </I18n>,
      );
    });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-part='open-in-t3']")];
    expect(buttons.map((b) => b.closest("[data-entry]")?.getAttribute("data-entry-key"))).toEqual([
      "r:la_t3000",
    ]);
    act(() => {
      buttons[0]?.click();
    });
    expect(asked).toEqual(["la_t3000"]);
    const text = entries().map((e) => e.querySelector("[data-part='entry-text']")?.textContent);
    expect(text).toContain(
      "Did not open: T3 Code does not offer its default model: choose another in T3 Code",
    );
    expect(text).toContain(
      "Did not open: the pairing with T3 Code does not allow it: pair again, choosing Full access",
    );
  });
});

describe("[A5.while-away.web.thread-older] Earlier shows what the page holds, then Older entries reads further", () => {
  test("Earlier reveals the held entries; then Older entries asks once, says it reads, and goes with the last of them", () => {
    const notes = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      note(`n${String(i)}`, `Note ${String(i)}`, [], AT + i * 60_000),
    );
    let asked = 0;
    const draw = (partial: boolean, loadingOlder: boolean, shown = notes) => {
      act(() => {
        root ??= createRoot(host);
        root.render(
          <I18n>
            <Thread
              notes={shown}
              log={[]}
              receipts={[]}
              instances={[CLAUDE]}
              partial={partial}
              onOlder={() => {
                asked += 1;
              }}
              loadingOlder={loadingOlder}
            />
          </I18n>,
        );
      });
    };
    const button = () => host.querySelector<HTMLButtonElement>("[data-part='earlier']");
    draw(true, false);
    expect(button()?.textContent).toBe("Earlier · 2");
    act(() => {
      button()?.click();
    });
    expect(entries()).toHaveLength(8);
    expect(button()?.textContent).toBe("Older entries");
    act(() => {
      button()?.click();
    });
    expect(asked).toBe(1);
    draw(true, true);
    expect(button()?.textContent).toBe("Reading older entries…");
    expect(button()?.getAttribute("aria-busy")).toBe("true");
    act(() => {
      button()?.click();
    });
    expect(asked).toBe(1);
    // The first entry came: no button is left, and every entry shows.
    const older = [note("n0", "Note 0", [], AT), ...notes];
    draw(false, false, older);
    expect(button()).toBeNull();
    expect(entries()).toHaveLength(9);
  });

  test("a first read with no entry but more behind it offers Older entries; a failed read says so once and can be pressed again", () => {
    let asked = 0;
    const draw = (shown: DetailNote[], olderFailed: boolean) => {
      act(() => {
        root ??= createRoot(host);
        root.render(
          <I18n>
            <Thread
              notes={shown}
              log={[]}
              receipts={[]}
              instances={[CLAUDE]}
              partial
              onOlder={() => {
                asked += 1;
              }}
              olderFailed={olderFailed}
            />
          </I18n>,
        );
      });
    };
    const button = () => host.querySelector<HTMLButtonElement>("[data-part='earlier']");
    draw([], false);
    expect(host.textContent).not.toContain("Nothing logged yet.");
    expect(button()?.textContent).toBe("Older entries");
    act(() => {
      button()?.click();
    });
    expect(asked).toBe(1);
    draw([], true);
    expect(host.querySelector("[role='status']")?.textContent).toBe(
      "Older entries could not be read.",
    );
    expect(button()?.textContent).toBe("Older entries");
    expect(button()?.getAttribute("aria-busy")).toBe("false");
    act(() => {
      button()?.click();
    });
    expect(asked).toBe(2);
  });
});

describe("[A5.note.retract.web.thread] a note is taken back from its line in the thread", () => {
  const removeButtons = () => [
    ...host.querySelectorAll<HTMLButtonElement>("[data-part='remove-note']"),
  ];

  test("Remove on a note and on a session's request takes back that note; a card that only reads offers none", () => {
    const mine = note("n1", "Meant for another task", []);
    const asked = note("n2", "Check the clinic export first", ["L7KQ21"]);
    const taken: string[] = [];
    render([mine, asked], [receipt("la_1", "L7KQ21", "confirmed", AT + 60_000)], undefined, {
      onRemove: (n) => taken.push(n.ref),
    });
    const buttons = removeButtons();
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove your note",
      "Remove the request to Claude Code · work",
    ]);
    act(() => {
      for (const button of buttons) button.click();
    });
    expect(taken).toEqual(["n1", "n2"]);

    render([mine, asked], [receipt("la_1", "L7KQ21", "confirmed", AT + 60_000)]);
    expect(removeButtons()).toEqual([]);
  });

  test("a session whose request was taken back says so, without its words, and offers no Remove", () => {
    const asked = note("n2", "Check the clinic export first", ["L7KQ21"]);
    render([], [{ ...receipt("la_1", "L7KQ21", "confirmed", AT), request: "n2" }], undefined, {
      removed: [asked],
      onRemove: () => undefined,
    });
    expect(entries()).toHaveLength(1);
    expect(askedIn(entries()[0])).toBeUndefined();
    expect(entries()[0]?.querySelector("[data-part='asked-removed']")?.textContent).toBe(
      "Request removed",
    );
    expect(entries()[0]?.textContent).not.toContain("Check the clinic export first");
    expect(removeButtons()).toEqual([]);
  });
});

describe("[A5.entry.correct.web.thread] the pen on a note and a log entry corrects its words in place", () => {
  afterEach(() => {
    localStorage.clear();
  });

  const agentNote: DetailNote = { ...note("n1", "Drafted teh reply", []), author: "agent:codex" };
  const progress: DetailLog = {
    kind: "log",
    ref: "l1",
    author: "agent:codex",
    at: new Date(AT + 30_000).toISOString(),
    text: "Checked the invoce",
    logKind: "progress",
  };
  const pens = () => [...host.querySelectorAll<HTMLButtonElement>("[data-part='pen']")];
  const box = () => host.querySelector<HTMLTextAreaElement>("[data-part='text-edit']");
  const notSaved = () =>
    [...host.querySelectorAll("[data-part='not-saved-value']")].map((line) => line.textContent);
  const type = (words: string) => {
    const field = box();
    if (field === null) throw new Error("no box");
    act(() => {
      field.value = words;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = (key: string) => {
    act(() => {
      box()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  const leave = () => {
    act(() => {
      box()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      box()?.blur();
    });
  };
  const settle = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  type Save = [string, string, string | undefined];
  const editing = (saves: Save[], answer: () => Promise<void> = () => Promise.resolve()) => ({
    space: "sp_fixture",
    task: "t_fixture",
    base: "1.40.abc",
    save: (entry: string, words: string, base: string | undefined) => {
      saves.push([entry, words, base]);
      return answer();
    },
  });

  test("every note and log entry has a pen that opens its words; a session's entry and a card that only reads have none", () => {
    const mine = note("n2", "Ask about the invoice", [], AT + 60_000);
    const asked = note("n3", "Check the clinic export first", ["L7KQ21"]);
    render(
      [agentNote, mine, asked],
      [receipt("la_1", "L7KQ21", "confirmed", AT + 90_000)],
      undefined,
      {
        log: [progress],
        edit: editing([]),
      },
    );
    expect(pens()).toHaveLength(3);
    act(() => {
      pens()[1]?.click();
    });
    expect(box()?.value).toBe("Checked the invoce");
    expect(document.activeElement).toBe(box());
    render([agentNote, mine], [], undefined, { log: [progress] });
    expect(pens()).toEqual([]);
  });

  test("Enter saves the words exactly as typed, from the base, and the entry shows them at once", async () => {
    const saves: Save[] = [];
    render([agentNote], [], undefined, { log: [progress], edit: editing(saves) });
    act(() => {
      pens()[1]?.click();
    });
    const words = ["", "  Checked the invoice:", "", "- total  ", ""].join(String.fromCharCode(10));
    type(words);
    press("Enter");
    await settle();
    expect(saves).toEqual([["l1", words, "1.40.abc"]]);
    expect(box()).toBeNull();
    expect(entries()[1]?.textContent).toContain("Checked the invoice:");
  });

  test("a box the person did not change writes nothing: closed, let go, or opened over words that changed since", async () => {
    const saves: Save[] = [];
    render([agentNote], [], undefined, { edit: editing(saves) });
    act(() => {
      pens()[0]?.click();
    });
    press("Enter");
    act(() => {
      pens()[0]?.click();
    });
    type("Drafted the");
    press("Escape");
    expect(entries()[0]?.textContent).toContain("Drafted teh reply");
    // The words change under an open, untouched box: leaving it saves nothing over them.
    act(() => {
      pens()[0]?.click();
    });
    render([{ ...agentNote, text: "Drafted the reply to Ana" }], [], undefined, {
      edit: editing(saves),
    });
    leave();
    await settle();
    expect(saves).toEqual([]);
    expect(box()).toBeNull();
  });

  test("words typed and not sent come back in the box after a reload", () => {
    const saves: Save[] = [];
    render([agentNote], [], undefined, { edit: editing(saves) });
    act(() => {
      pens()[0]?.click();
    });
    type("Drafted the reply to Ana");
    act(() => {
      root?.unmount();
    });
    root = undefined;
    render([agentNote], [], undefined, { edit: editing(saves) });
    expect(box()?.value).toBe("Drafted the reply to Ana");
    expect(saves).toEqual([]);
  });

  test("a refused save is never sent again: the box closes on the words as they are now, and the person's wait under them with Copy and Discard, also after a reload", async () => {
    const saves: Save[] = [];
    const refused = () => Promise.reject(Object.assign(new Error("changed"), { code: "conflict" }));
    render([agentNote], [], undefined, { edit: editing(saves, refused) });
    act(() => {
      pens()[0]?.click();
    });
    type("Drafted the reply");
    press("Enter");
    await settle();
    expect(saves).toHaveLength(1);
    expect(box()).toBeNull();
    const now = { ...agentNote, text: "Drafted the reply to Ana, by another tab" };
    render([now], [], undefined, { edit: editing(saves, refused) });
    expect(entries()[0]?.textContent).toContain("by another tab");
    expect(notSaved()).toEqual(["Drafted the reply"]);
    // The pen opens on what is there now; leaving it untouched writes nothing.
    act(() => {
      pens()[0]?.click();
    });
    expect(box()?.value).toBe(now.text);
    leave();
    await settle();
    expect(saves).toHaveLength(1);
    // The words wait after a reload, until the person discards them.
    act(() => {
      root?.unmount();
    });
    root = undefined;
    render([now], [], undefined, { edit: editing(saves, refused) });
    expect(notSaved()).toEqual(["Drafted the reply"]);
    act(() => {
      host.querySelector<HTMLButtonElement>("[data-part='discard-not-saved']")?.click();
    });
    expect(notSaved()).toEqual([]);
  });

  test("an entry the card holds only in part opens no box, so a save never holds less than its text", () => {
    const saves: Save[] = [];
    render([{ ...agentNote, partial: true }], [], undefined, { edit: editing(saves) });
    expect(pens()[0]?.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      pens()[0]?.click();
    });
    expect(box()).toBeNull();
  });

  test("a corrected entry says who corrected it after its time", () => {
    render([{ ...agentNote, edited: { at: new Date(AT).toISOString(), by: "user" } }], []);
    expect(entries()[0]?.querySelector("[data-part='edited']")?.textContent).toContain("you");
  });
});

describe("[M6.page.run-continue] a run that holds its agent's conversation offers Continue in its instance", () => {
  const run = (patch: Partial<Run>): Run => ({
    id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
    instance: "claude",
    state: "succeeded",
    reason: null,
    queued_at: AT,
    started_at: AT + 1_000,
    ended_at: AT + 60_000,
    asked: null,
    answer: "The export drops the time zone.",
    answer_final: true,
    answer_cut: false,
    version: 6,
    ...patch,
  });
  const draw = (runs: readonly Run[], onContinue: (run: Run, instance: Instance) => void) => {
    act(() => {
      root ??= createRoot(host);
      root.render(
        <I18n>
          <Thread
            notes={[]}
            log={[]}
            receipts={[]}
            runs={runs}
            instances={[CLAUDE]}
            partial={false}
            onStop={() => undefined}
            onContinue={onContinue}
          />
        </I18n>,
      );
    });
  };
  const buttons = () => [...host.querySelectorAll<HTMLElement>("[data-part='run-continue']")];

  test("an ended run's Continue opens it in the run's instance; a working one offers Stop and continue beside Stop", () => {
    const pressed: [string, string][] = [];
    draw([run({ resumable: true })], (r, instance) => pressed.push([r.id, instance.key]));
    expect(buttons().map((b) => b.textContent)).toEqual(["Continue"]);
    expect(buttons()[0]?.getAttribute("aria-label")).toBe(
      "Continue Claude Code · work's conversation",
    );
    act(() => {
      buttons()[0]?.click();
    });
    expect(pressed).toEqual([["ru_00r5mfcw5rfzxb9enb2vg50z3g", "claude"]]);

    // A run that may still work: its two ways out stand together on its state's line.
    draw(
      [
        run({
          state: "running",
          ended_at: null,
          resumable: true,
          answer: "Long work. ".repeat(400),
        }),
      ],
      () => undefined,
    );
    expect(buttons().map((b) => b.textContent)).toEqual(["Stop and continue"]);
    const line = buttons()[0]?.closest("[data-part='run-state']");
    expect([...(line?.querySelectorAll("button") ?? [])].map((b) => b.dataset["part"])).toEqual([
      "run-stop",
      "run-continue",
    ]);
  });

  test("a run without its agent's conversation, or of an instance this machine no longer has, offers none", () => {
    draw([run({})], () => undefined);
    expect(buttons()).toEqual([]);
    draw([run({ instance: "gone", resumable: true })], () => undefined);
    expect(buttons()).toEqual([]);
  });
});
