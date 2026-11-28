// @vitest-environment happy-dom
//
// The effort levels' grid in Settings: each change saves at once with the write a person expects
// (the list and the moves that carry tasks along) and shows at once; typing saves nothing until
// Enter or leaving the field; a name the writer would refuse says why under the field and sends
// nothing; removing a level that tasks hold asks only where they go; the bounds show; Alt+Up and
// Alt+Down move a level and keep focus on it; a refused save keeps what the person typed; a space
// whose levels this build cannot change shows them read-only and says why.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EFFORT_LEVELS, type EffortHeld, type EffortLevel } from "@ttasks/contracts/preferences";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { editsOf } from "../edit/useEdits.ts";
import type { Toast } from "../edit/edits.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { Scales } from "@ttasks/client/store";
import { FakeFrames } from "../../test/fake-frames.ts";
import { EffortLevels } from "./EffortLevels.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const INCARNATION = "ai_0123456789abcdefghjkmnpq";
const AS_OF = "1.10.01234567";

interface SetCall {
  readonly input: {
    readonly set: readonly { readonly value: EffortLevel[]; readonly moves?: unknown[] }[];
    readonly base?: string;
  };
  readonly resolve: (answer: unknown) => void;
  readonly reject: (error: Error) => void;
}

let container: HTMLDivElement;
let root: Root;
let live: Live;
let sets: SetCall[];
let held: EffortHeld[];
let toasts: (Toast | undefined)[];

function show(scales: Partial<Scales>, seq = 10): void {
  act(() => {
    live.store.push({
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 1, incarnation: INCARNATION, seq },
      tasks: [],
      nodes: [],
      instances: [],
      scales: { statuses: ["open"], efforts: [...EFFORT_LEVELS], ...scales },
    });
    live.store.flush();
  });
}

beforeEach(async () => {
  sets = [];
  held = [];
  toasts = [];
  const api = {
    client: {
      task: {},
      history: {},
      receipt: { get: () => new Promise(() => undefined) },
      prefs: {
        manage: (input: { action: string }) =>
          input.action === "get"
            ? Promise.resolve({
                action: "get",
                as_of: AS_OF,
                prefs: [{ key: "tasks.effort_scale", held, writable: true, default: [] }],
              })
            : new Promise((resolve, reject) => {
                sets.push({ input: input as unknown as SetCall["input"], resolve, reject });
              }),
      },
    },
    busy: () => Promise.resolve({ busy: [], last: {} }),
    receipts: () => Promise.resolve([]),
  } as unknown as Api;
  live = new Live({
    api,
    route: { space: SPACE.id },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames: new FakeFrames(),
  });
  editsOf(live, api).onToast((toast) => toasts.push(toast));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18n>
        <Session.Provider value={{ api, live }}>
          <EffortLevels headingClass="" />
        </Session.Provider>
      </I18n>,
    );
  });
  await settle();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
});

/** Lets the edits' queue send what waits, and the held counts arrive. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

let landed = 11;
/** The service takes the newest write. */
const answer = async (more: Record<string, unknown> = {}) => {
  await act(async () => {
    landed += 1;
    sets.at(-1)?.resolve({
      action: "set",
      as_of: `1.${String(landed)}.01234567`,
      result: "updated",
      ...more,
    });
    await Promise.resolve();
  });
  await settle();
};

const field = (part: string, at = 0): HTMLInputElement => {
  const found = container.querySelectorAll<HTMLInputElement>(`[data-part="${part}"]`)[at];
  if (found === undefined) throw new Error(`no ${part} at ${String(at)}`);
  return found;
};
const picker = (part: string): HTMLSelectElement => {
  const found = container.querySelector<HTMLSelectElement>(`[data-part="${part}"]`);
  if (found === null) throw new Error(`no ${part}`);
  return found;
};
const button = (part: string, at = 0): HTMLElement => {
  const found = container.querySelectorAll<HTMLElement>(`[data-part="${part}"]`)[at];
  if (found === undefined) throw new Error(`no ${part} at ${String(at)}`);
  return found;
};
const names = () =>
  [...container.querySelectorAll<HTMLInputElement>('[data-part="level-name"]')].map((i) => i.value);
const lineOf = (input: HTMLInputElement) => {
  const id = input.getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
};

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function key(target: HTMLElement, name: string, options: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...options }));
  });
}
function press(target: HTMLElement): void {
  act(() => {
    target.click();
  });
}
function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The newest write: its list by name, and its moves. */
const sent = () => {
  const set = sets.at(-1)?.input.set[0];
  return { names: set?.value.map((l) => l.key), moves: set?.moves ?? [] };
};

describe("[A5.3.7.web.levels-grid] the effort levels' grid in Settings", () => {
  test("each kind of change sends its list and moves at once, and shows at once", async () => {
    held = [{ effort: "M", active: 10, finished: 2, trash: 0 }];
    show({});
    await settle();
    expect(names()).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(container.textContent).toContain("They belong to the space Mira");

    // A rename: typing sends nothing; the line says who moves with it; Enter saves it.
    const m = field("level-name", 2);
    type(m, "Medium");
    expect(sets).toHaveLength(0);
    expect(lineOf(m)).toBe("12 tasks move with it");
    key(m, "Enter");
    await settle();
    expect(sent()).toEqual({
      names: ["XS", "S", "Medium", "L", "XL"],
      moves: [{ from: "M", to: "Medium" }],
    });
    expect(names()).toEqual(["XS", "S", "Medium", "L", "XL"]);
    await answer({ moved: [{ from: "M", to: "Medium", active: 10, finished: 2, trash: 0 }] });
    expect(toasts.at(-1)?.kind).toBe("info");
    expect(toasts.at(-1)?.text).toMatchObject({
      id: "levels.saved",
      values: { kind: "rename", from: "M", name: "Medium", moved: 12, how: "with" },
    });

    // A time, by its amount and Enter, and by its unit; a line, by leaving the field.
    type(field("level-amount", 3), "3");
    key(field("level-amount", 3), "Enter");
    await settle();
    expect(sets.at(-1)?.input.set[0]?.value[3]).toEqual({
      ...EFFORT_LEVELS[3],
      time: { amount: 3, unit: "days" },
    });
    await answer();
    choose(picker("level-unit"), "hours");
    await settle();
    expect(sets.at(-1)?.input.set[0]?.value[0]?.time).toEqual({ amount: 10, unit: "hours" });
    await answer();
    const about = field("level-about", 4);
    type(about, "Too big to plan");
    expect(sets).toHaveLength(3);
    act(() => {
      about.blur();
    });
    await settle();
    expect(sets.at(-1)?.input.set[0]?.value[4]?.about).toBe("Too big to plan");
    await answer();

    // Reorder by its button.
    press(button("level-down", 0));
    await settle();
    expect(sent()).toEqual({ names: ["S", "XS", "Medium", "L", "XL"], moves: [] });
    await answer();

    // Add: the new level's name has the focus, and Enter saves it.
    press(button("level-add"));
    const added = field("level-name", 5);
    expect(document.activeElement).toBe(added);
    type(added, "XXL");
    key(added, "Enter");
    await settle();
    expect(sent().names).toEqual(["S", "XS", "Medium", "L", "XL", "XXL"]);
    expect(document.activeElement).toBe(field("level-name", 5));
  });

  test("removing a level nobody holds asks nothing; one tasks hold asks where they go", async () => {
    held = [{ effort: "M", active: 5, finished: 2, trash: 1 }];
    show({});
    await settle();
    press(button("level-remove", 0));
    await settle();
    expect(sent()).toEqual({ names: ["S", "M", "L", "XL"], moves: [] });
    await answer();
    expect(container.querySelector('[data-part="level-ask"]')).toBeNull();

    press(button("level-remove", 1));
    expect(sets).toHaveLength(1);
    const ask = container.querySelector('[data-part="level-ask"]');
    expect(ask?.textContent).toContain(
      "8 tasks are M, 2 of them finished, 1 in the Trash. Move them to:",
    );
    const to = picker("level-ask-to");
    expect(document.activeElement).toBe(to);
    expect(to.value).toBe("L");
    expect([...to.options].map((o) => o.textContent)).toEqual(["S", "L", "XL", "No size"]);
    // Escape keeps the level and asks nothing more.
    key(to, "Escape");
    expect(container.querySelector('[data-part="level-ask"]')).toBeNull();
    expect(sets).toHaveLength(1);

    press(button("level-remove", 1));
    choose(picker("level-ask-to"), "");
    press(button("level-ask-remove"));
    await settle();
    expect(sent()).toEqual({ names: ["S", "L", "XL"], moves: [{ from: "M", to: null }] });
  });

  test("a name the writer would refuse says why and sends nothing; the bounds show", async () => {
    show({ efforts: [{ key: "S" }, { key: "M" }] });
    await settle();
    const m = field("level-name", 1);
    type(m, "s");
    expect(lineOf(m)).toBe("Another level is called s");
    expect(m.getAttribute("aria-invalid")).toBe("true");
    key(m, "Enter");
    act(() => {
      m.blur();
    });
    type(m, "M/L");
    expect(lineOf(m)).toBe("Names use letters, digits, spaces, - _ and .");
    key(m, "Enter");
    expect(m.value).toBe("M/L");
    await settle();
    expect(sets).toHaveLength(0);
    // Escape takes the typing back.
    key(m, "Escape");
    expect(m.value).toBe("M");
    expect(m.maxLength).toBe(10);

    expect(button("level-count").textContent).toBe("2 of 10");
    const about = field("level-about", 0);
    type(about, "x".repeat(239));
    expect(lineOf(about)).toBeUndefined();
    type(about, "x".repeat(240));
    expect(lineOf(about)).toBe("240 of 280");
    expect(about.maxLength).toBe(280);
    key(about, "Escape");
    type(field("level-amount", 0), "0");
    expect(lineOf(field("level-amount", 0))).toBe("A time is a whole number from 1 to 999");
    key(field("level-amount", 0), "Escape");
    expect(sets).toHaveLength(0);

    show({ efforts: Array.from({ length: 10 }, (_, i) => ({ key: `E${String(i)}` })) }, 11);
    expect(button("level-count").textContent).toBe("10 of 10");
    expect(button("level-add").hasAttribute("disabled")).toBe(true);
    show({ efforts: [{ key: "M" }] }, 12);
    expect(button("level-remove").hasAttribute("disabled")).toBe(true);
  });

  test("Alt+Up and Alt+Down move the level and keep focus on its name", async () => {
    show({});
    await settle();
    const m = field("level-name", 2);
    act(() => {
      m.focus();
    });
    key(m, "ArrowUp", { altKey: true });
    await settle();
    expect(sent().names).toEqual(["XS", "M", "S", "L", "XL"]);
    expect(document.activeElement).toBe(field("level-name", 1));
    expect(field("level-name", 1).value).toBe("M");
    await answer();
    key(field("level-name", 1), "ArrowDown", { altKey: true });
    key(field("level-name", 2), "ArrowDown", { altKey: true });
    await settle();
    await answer();
    await settle();
    expect(sent().names).toEqual(["XS", "S", "L", "M", "XL"]);
    expect(document.activeElement).toBe(field("level-name", 3));
    // The fields follow in reading order: name, time, unit, line, then the level's buttons.
    const parts = [
      ...container.querySelectorAll(
        'li[data-level="M"] input, li[data-level="M"] select, li[data-level="M"] button',
      ),
    ].map((e) => e.getAttribute("data-part"));
    expect(parts.slice(0, 4)).toEqual(["level-name", "level-amount", "level-unit", "level-about"]);
  });

  test("a refused save keeps what the person typed and shows the levels as they are", async () => {
    show({});
    await settle();
    const m = field("level-name", 2);
    type(m, "Medium");
    key(m, "Enter");
    await settle();
    expect(names()[2]).toBe("Medium");
    await act(async () => {
      sets.at(-1)?.reject(Object.assign(new Error("Changed"), { code: "conflict", data: {} }));
      await Promise.resolve();
    });
    await settle();
    expect(m.value).toBe("Medium");
    expect(lineOf(m)).toBe("Not saved. Enter tries again.");
    expect(names().filter((_, i) => i !== 2)).toEqual(["XS", "S", "L", "XL"]);
    expect(field("level-name", 3).value).toBe("L");
  });

  test("levels this build cannot change show read-only, with why", async () => {
    show({ effortsFixed: "newer" });
    await settle();
    expect(container.querySelector('[data-part="levels-fixed"]')?.textContent).toContain(
      "A newer build of TTasks changed these levels",
    );
    expect(field("level-name", 0).readOnly).toBe(true);
    expect(container.querySelector('[data-part="level-remove"]')).toBeNull();
    expect(container.querySelector('[data-part="level-add"]')).toBeNull();
    show({ effortsFixed: "unreadable" }, 11);
    expect(container.querySelector('[data-part="levels-fixed"]')?.textContent).toContain(
      "prefs set tasks.effort_scale --reset",
    );
  });

  test("what is typed in a name stays with its level when another level goes", async () => {
    show({ efforts: [{ key: "S" }, { key: "M" }, { key: "L" }] });
    await settle();
    const m = field("level-name", 1);
    type(m, "S");
    // Pressing Remove leaves the field: the name is taken, so nothing is saved yet.
    press(button("level-remove", 0));
    await settle();
    expect(sent()).toEqual({ names: ["M", "L"], moves: [] });
    await answer();
    const typed = container.querySelector<HTMLInputElement>(
      'li[data-level="M"] [data-part="level-name"]',
    );
    expect(typed?.value).toBe("S");
    if (typed === null) throw new Error("M's name field is gone");
    key(typed, "Enter");
    await settle();
    expect(sent()).toEqual({ names: ["S", "L"], moves: [{ from: "M", to: "S" }] });
  });

  test("a time that is not a whole number is kept as typed and not saved", async () => {
    show({});
    await settle();
    const amount = field("level-amount", 0);
    type(amount, "1.5");
    expect(amount.value).toBe("1.5");
    expect(lineOf(amount)).toBe("A time is a whole number from 1 to 999");
    key(amount, "Enter");
    await settle();
    expect(sets).toHaveLength(0);
  });

  test("Alt+Up on a name being typed saves the name once, then moves the level", async () => {
    show({});
    await settle();
    const m = field("level-name", 2);
    type(m, "Medium");
    key(m, "ArrowUp", { altKey: true });
    await settle();
    await answer();
    await answer();
    await answer();
    expect(sets.map((s) => s.input.set[0]?.value.map((l) => l.key))).toEqual([
      ["XS", "S", "Medium", "L", "XL"],
      ["XS", "Medium", "S", "L", "XL"],
    ]);
    expect(document.activeElement).toBe(field("level-name", 1));
  });

  test("Alt+Up and Alt+Down change nothing when the levels are read-only", async () => {
    show({ effortsFixed: "unreadable" });
    await settle();
    const m = field("level-name", 2);
    act(() => {
      m.focus();
    });
    key(m, "ArrowUp", { altKey: true });
    key(m, "ArrowDown", { altKey: true });
    await settle();
    expect(sets).toHaveLength(0);
  });
});
