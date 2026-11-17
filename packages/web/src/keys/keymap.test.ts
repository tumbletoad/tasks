// @vitest-environment happy-dom
//
// The keymap the page's handlers ask and the shortcut sheet lists: no two actions that can be
// reached at once share a key, no chord a browser keeps for itself is taken, and a single key
// fires only where a person is not typing, and only while single-letter keys are on.
import { afterEach, describe, expect, test } from "vitest";
import {
  actionOf,
  actionsIn,
  ariaKeys,
  isSingle,
  KEYMAP,
  type Binding,
  type KeyAction,
  type KeyPress,
  type KeyScope,
} from "./keymap.ts";

const SCOPES: readonly KeyScope[] = ["page", "list", "strip", "field"];
const ACTIONS = KEYMAP as readonly KeyAction[];

/** Focus is in one of list, strip and field at a time; the page's keys are reached with each. */
const together = (a: KeyScope, b: KeyScope): boolean => a === b || a === "page" || b === "page";

/** The key press that types `binding`, on `target`. */
function press(binding: Binding, target: EventTarget | null = document.body, extra = {}): KeyPress {
  return {
    key: binding.mod === true && binding.shift === true ? binding.key.toUpperCase() : binding.key,
    ctrlKey: binding.mod === true,
    metaKey: false,
    altKey: false,
    // `?` takes Shift on most layouts; the character is what counts.
    shiftKey: binding.shift === true || binding.key === "?",
    target,
    ...extra,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("[A7.3.12.m5-11.keymap] one keymap: no key does two things, and single keys never fire while a person types", () => {
  test("no two actions reached at the same time share a key, under the handlers' own matcher", () => {
    for (const action of ACTIONS) {
      for (const binding of action.keys) {
        for (const scope of SCOPES) {
          if (!together(scope, action.scope)) continue;
          // On a row, the row's keys are asked; in the field, the field's; the page's everywhere.
          const target = document.body;
          const found = actionOf(press(binding, target), scope, true);
          const expected = scope === action.scope ? action.id : undefined;
          // Keys of `expand` are the title button's own: the list's handler only names them.
          expect(found, `${action.id} ${JSON.stringify(binding)} in ${scope}`).toBe(expected);
        }
      }
    }
    // The same rule read off the map itself: every pair of actions reachable together.
    const same = (a: Binding, b: Binding) =>
      isSingle(a) && isSingle(b)
        ? a.key === b.key
        : a.key.toLowerCase() === b.key.toLowerCase() &&
          (a.mod === true) === (b.mod === true) &&
          (a.shift === true) === (b.shift === true);
    const clashes: string[] = [];
    ACTIONS.forEach((a, i) => {
      ACTIONS.slice(i + 1).forEach((b) => {
        if (!together(a.scope, b.scope)) return;
        for (const x of a.keys)
          for (const y of b.keys) if (same(x, y)) clashes.push(`${a.id}/${b.id}: ${x.key}`);
      });
    });
    expect(clashes).toEqual([]);
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });

  test("no chord a browser keeps for itself, and none that leaves the page", () => {
    const reserved = ["t", "w", "n", "Tab", "l", "r", "f", "p", "s", "q"];
    const chords = ACTIONS.flatMap((a) => a.keys.filter((b) => b.mod === true));
    expect(chords.filter((b) => reserved.includes(b.key))).toEqual([]);
  });

  test("a single key fires outside fields, with the character typed however it is made", () => {
    const n = { key: "n" };
    expect(actionOf(press(n), "page", true)).toBe("new");
    expect(actionOf(press({ key: "/" }), "page", true)).toBe("search");
    expect(actionOf(press({ key: "?" }), "page", true)).toBe("sheet");
    // AltGr types `[` on many layouts: Windows reports it as Ctrl and Alt.
    const altGr = {
      ctrlKey: true,
      altKey: true,
      getModifierState: (k: string) => k === "AltGraph",
    };
    expect(actionOf(press({ key: "[" }, document.body, altGr), "list", true)).toBe(
      "previous-group",
    );
    // A focused button, a checkbox and a radio button are not fields.
    for (const html of [
      "<button>Star</button>",
      '<input type="checkbox">',
      '<div role="radiogroup"><input type="radio"></div>',
    ]) {
      document.body.innerHTML = html;
      const target = document.body.querySelector("button, input");
      expect(actionOf(press(n, target), "page", true), html).toBe("new");
    }
  });

  test("a single key never fires in a field, a composition, a typing widget, a dialog, with a modifier, or when turned off", () => {
    const fields = [
      '<input type="text">',
      '<input type="search">',
      "<textarea></textarea>",
      '<div contenteditable="true"></div>',
      "<select><option>a</option></select>",
      '<div role="menu"><div role="menuitem" tabindex="0">a</div></div>',
      '<div role="listbox"><div role="option" tabindex="0">a</div></div>',
      '<div role="grid"><div role="gridcell" tabindex="0">1</div></div>',
      '<div role="dialog"><button>Close</button></div>',
    ];
    for (const html of fields) {
      document.body.innerHTML = html;
      const target = document.body.querySelector(
        "input, textarea, [contenteditable], select, [tabindex], button",
      );
      for (const key of ["n", "/", "?"]) {
        expect(actionOf(press({ key }, target), "page", true), `${key} in ${html}`).toBeUndefined();
      }
      expect(actionOf(press({ key: "j" }, target), "list", true), html).toBeUndefined();
    }
    const n = { key: "n" };
    expect(actionOf(press(n, document.body, { isComposing: true }), "page", true)).toBeUndefined();
    expect(actionOf(press(n, document.body, { keyCode: 229 }), "page", true)).toBeUndefined();
    for (const held of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(actionOf(press(n, document.body, held), "page", true), JSON.stringify(held)).toBe(
        undefined,
      );
    }
    // Turned off: no single key anywhere; arrows and chords still work.
    for (const action of ACTIONS) {
      for (const binding of action.keys) {
        const found = actionOf(press(binding), action.scope, false);
        if (isSingle(binding)) expect(found, `${action.id} ${binding.key}`).toBeUndefined();
        else if (action.inFields === true || action.scope !== "field")
          expect(found).toBe(action.id);
      }
    }
  });

  test("chords work in fields only where the field has no use for them", () => {
    document.body.innerHTML = '<input type="text">';
    const field = document.body.querySelector("input");
    // Ctrl+K searches from anywhere; Ctrl+Z is the field's own undo of its text.
    expect(actionOf(press({ key: "k", mod: true }, field), "page", true)).toBe("search");
    expect(actionOf(press({ key: "z", mod: true }, field), "page", true)).toBeUndefined();
    expect(actionOf(press({ key: "z", mod: true }), "page", true)).toBe("undo");
    expect(actionOf(press({ key: "z", mod: true, shift: true }), "page", true)).toBe("redo");
    // Cmd on macOS.
    const cmd = { key: "k", ctrlKey: false, metaKey: true };
    expect(actionOf(press({ key: "k", mod: true }, document.body, cmd), "page", true)).toBe(
      "search",
    );
    // In the narrow layout's menu or the sheet, the page waits.
    document.body.innerHTML = '<div role="dialog" aria-modal="true"><button>x</button></div>';
    const inside = document.body.querySelector("button");
    expect(actionOf(press({ key: "k", mod: true }, inside), "page", true)).toBeUndefined();
  });

  test("the sheet lists what works: without single keys, an action keeps only its other keys", () => {
    const on = actionsIn(["page", "list"], true).map((a) => a.id);
    expect(on).toEqual(expect.arrayContaining(["new", "search", "sheet", "next", "rename"]));
    expect(on).not.toContain("day");
    const off = actionsIn(["page", "list"], false);
    expect(off.map((a) => a.id)).not.toContain("new");
    expect(off.map((a) => a.id)).not.toContain("next-group");
    expect(off.find((a) => a.id === "search")?.keys).toEqual([{ key: "k", mod: true }]);
    expect(off.find((a) => a.id === "next")?.keys).toEqual([{ key: "ArrowDown" }]);
    expect(ariaKeys([{ key: "/" }, { key: "k", mod: true }], false)).toBe("/ Control+K");
    expect(ariaKeys([{ key: "k", mod: true }], true)).toBe("Meta+K");
  });
});
