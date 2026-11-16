// Every key the page answers, in one map: the handlers ask it which action a key press is, and the
// shortcut sheet lists it, so the two cannot drift. A test over the map proves that no two actions
// that can be reached at the same time share a key.
//
// A single key (a character without Ctrl, Cmd or Alt: `n`, `/`, `?`, `j`) never fires while a
// person types in a field, while an input method composes, inside a widget that takes typed
// characters itself (a menu, a list box, a calendar) or in a dialog, and not at all when the person
// turned single-letter keys off (for a screen reader or voice control). A character matches the
// character typed (`event.key`), however the layout produces it: with Shift, or with AltGr.
import type { MessageId } from "../i18n/intl.tsx";

/**
 * Where an action is reached: `page` anywhere in the page, `list` on a task's row, `strip` on a day
 * of Today's week, `field` in the top field. Focus is in one of the last three at a time; `page`
 * is reached alongside each.
 */
export type KeyScope = "page" | "list" | "strip" | "field";

export interface Binding {
  /** `event.key`: one character, or a named key such as `ArrowDown`, `Escape` or `F2`. */
  readonly key: string;
  /** With Ctrl, or Cmd on macOS. */
  readonly mod?: true;
  /** With Shift. A character never says so: the character typed is what counts. */
  readonly shift?: true;
}

export interface KeyAction {
  readonly id: string;
  readonly scope: KeyScope;
  readonly keys: readonly Binding[];
  readonly label: MessageId;
  /** Also while focus is in a text field: a chord with Ctrl, or the field's own keys. */
  readonly inFields?: true;
}

export const KEYMAP = [
  { id: "new", scope: "page", keys: [{ key: "n" }], label: "keys.new" },
  {
    id: "search",
    scope: "page",
    keys: [{ key: "/" }, { key: "k", mod: true }],
    label: "keys.search",
    inFields: true,
  },
  { id: "sheet", scope: "page", keys: [{ key: "?" }], label: "keys.sheet" },
  { id: "undo", scope: "page", keys: [{ key: "z", mod: true }], label: "keys.undo" },
  {
    id: "redo",
    scope: "page",
    keys: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
    label: "keys.redo",
  },
  { id: "message", scope: "page", keys: [{ key: "F6" }], label: "keys.message", inFields: true },
  { id: "close", scope: "page", keys: [{ key: "Escape" }], label: "keys.close", inFields: true },

  { id: "next", scope: "list", keys: [{ key: "j" }, { key: "ArrowDown" }], label: "keys.next" },
  {
    id: "previous",
    scope: "list",
    keys: [{ key: "k" }, { key: "ArrowUp" }],
    label: "keys.previous",
  },
  { id: "first", scope: "list", keys: [{ key: "Home" }], label: "keys.first" },
  { id: "last", scope: "list", keys: [{ key: "End" }], label: "keys.last" },
  { id: "next-group", scope: "list", keys: [{ key: "]" }], label: "keys.nextGroup" },
  { id: "previous-group", scope: "list", keys: [{ key: "[" }], label: "keys.previousGroup" },
  // The title is a button: the browser opens and closes the task on Enter and Space.
  { id: "expand", scope: "list", keys: [{ key: "Enter" }, { key: " " }], label: "keys.expand" },
  { id: "rename", scope: "list", keys: [{ key: "F2" }], label: "keys.rename" },

  {
    id: "day",
    scope: "strip",
    keys: [{ key: "ArrowLeft" }, { key: "ArrowRight" }],
    label: "keys.days",
  },
  {
    id: "day-ends",
    scope: "strip",
    keys: [{ key: "Home" }, { key: "End" }],
    label: "keys.dayEnds",
  },

  { id: "add", scope: "field", keys: [{ key: "Enter" }], label: "keys.add", inFields: true },
  {
    id: "results",
    scope: "field",
    keys: [{ key: "ArrowDown" }],
    label: "keys.results",
    inFields: true,
  },
  {
    id: "suggestion",
    scope: "field",
    keys: [{ key: "Tab" }],
    label: "keys.suggestion",
    inFields: true,
  },
] as const satisfies readonly KeyAction[];

export type ActionId = (typeof KEYMAP)[number]["id"];

/** A single key: one character typed without Ctrl, Cmd or Alt. */
export const isSingle = (binding: Binding): boolean =>
  binding.mod !== true && binding.key.length === 1 && binding.key !== " ";

/** What a key press is, as the map reads it (a DOM KeyboardEvent, or a test's object). */
export interface KeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly target?: EventTarget | null;
  getModifierState?(key: string): boolean;
}

/** Whether `press` is `binding`. */
export function matches(press: KeyPress, binding: Binding): boolean {
  // AltGr reports Ctrl and Alt on Windows: it types characters, it is not a command.
  const altGr = press.getModifierState?.("AltGraph") === true;
  const mod = !altGr && (press.ctrlKey || press.metaKey);
  const alt = !altGr && press.altKey;
  if (isSingle(binding)) return !mod && !alt && press.key === binding.key;
  if ((binding.mod === true) !== mod || alt) return false;
  if ((binding.shift === true) !== press.shiftKey) return false;
  return binding.mod === true ? press.key.toLowerCase() === binding.key : press.key === binding.key;
}

const TYPED_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color"]);

/** Widgets that take typed characters and arrows themselves: type-ahead, a calendar's grid. */
const OWN_KEYS =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="grid"], [role="tree"], ' +
  '[role="combobox"], [role="spinbutton"], [role="slider"], [role="textbox"]';

/** Whether focus is where a person types: a text field, or a widget that takes characters. */
export function inField(target: EventTarget | null | undefined): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement && !TYPED_INPUTS.has(target.type)) return true;
  return target.closest(OWN_KEYS) !== null;
}

/** Whether focus is in a modal dialog (the sheet, the narrow layout's menu): the page waits. */
function inModal(target: EventTarget | null | undefined): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest('[aria-modal="true"], [role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * The action `press` is in `scope`, or undefined. `singleKeys` is the person's setting: off, no
 * single key is anything.
 */
export function actionOf(
  press: KeyPress,
  scope: KeyScope,
  singleKeys: boolean,
): ActionId | undefined {
  // An input method's composition: the key is the composition's (229: Chromium's "Process").
  if (press.isComposing === true || press.keyCode === 229) return undefined;
  const modal = inModal(press.target);
  if (scope === "page" && modal) return undefined;
  const field = modal || inField(press.target);
  for (const action of KEYMAP as readonly KeyAction[]) {
    if (action.scope !== scope) continue;
    for (const binding of action.keys) {
      if (!matches(press, binding)) continue;
      if (isSingle(binding) && (!singleKeys || field)) continue;
      if (field && action.inFields !== true) continue;
      return action.id as ActionId;
    }
  }
  return undefined;
}

/**
 * Whether `press` is one of the keys of `id`, wherever focus is: for a key a part of the page
 * answers inside itself, such as Escape closing what is open.
 */
export function is(press: KeyPress, id: ActionId): boolean {
  if (press.isComposing === true || press.keyCode === 229) return false;
  const action = (KEYMAP as readonly KeyAction[]).find((a) => a.id === id);
  return action?.keys.some((binding) => matches(press, binding)) ?? false;
}

/** The actions a view offers: the page's, and those of the parts it shows. */
export function actionsIn(scopes: readonly KeyScope[], singleKeys: boolean): KeyAction[] {
  return (KEYMAP as readonly KeyAction[]).flatMap((action) => {
    if (!scopes.includes(action.scope)) return [];
    const keys = action.keys.filter((binding) => singleKeys || !isSingle(binding));
    return keys.length === 0 ? [] : [{ ...action, keys }];
  });
}

/** The bindings of one action, as the sheet and a tooltip name them. */
export function keysOf(id: ActionId, singleKeys: boolean): readonly Binding[] {
  const action = (KEYMAP as readonly KeyAction[]).find((a) => a.id === id);
  return (action?.keys ?? []).filter((binding) => singleKeys || !isSingle(binding));
}

/** `aria-keyshortcuts`' form of a binding: `Control+K`, `Shift+?` is just `?`. */
export function ariaKeys(bindings: readonly Binding[], mac: boolean): string | undefined {
  const named: Readonly<Record<string, string>> = { " ": "Space" };
  const parts = bindings.map((binding) =>
    [
      ...(binding.mod === true ? [mac ? "Meta" : "Control"] : []),
      ...(binding.shift === true ? ["Shift"] : []),
      named[binding.key] ?? (binding.mod === true ? binding.key.toUpperCase() : binding.key),
    ].join("+"),
  );
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** Whether this computer is a Mac: Cmd stands where Ctrl does. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}
