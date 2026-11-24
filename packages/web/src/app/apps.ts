// This machine's agent apps as the page reads them (the service's hub/agent-apps.ts): each answer
// is checked by its shape before the page uses it. Each row has up to two switches; what the
// person turns over is sent with the token its view showed, and the service writes it only when
// nothing changed since.
import type { Api } from "../api.ts";

export type PartName = "open" | "tools";

/** What one action on a switch changes: its files, their lines, and the token Apply sends. */
export interface Changes {
  /** The file that changes, the home shown as `~`: the first, when several do. */
  readonly file: string;
  /** Every file that changes: the one, or several. */
  readonly files: readonly string[];
  /** Exactly what changes: the lines written or taken out, `# <file>` before each further file's. */
  readonly detail: readonly string[];
  readonly plan: string;
}

export interface Part extends Changes {
  readonly on: boolean;
  /** What turning it over does; null when the page cannot. */
  readonly change: "add" | "remove" | null;
  readonly why: string | undefined;
  /** The file the reason is about, when the home has several. */
  readonly whyFile: string | undefined;
  /** tools: the space its entry names. */
  readonly space: { readonly id: string; readonly name: string | null } | undefined;
  /** tools that show off while their access may be live: turning them off all the same. */
  readonly off: Changes | undefined;
  /** tools that show on while one of the home's files has no entry: writing it there. */
  readonly add: Changes | undefined;
}

export interface AppRow {
  readonly key: string;
  readonly app: string;
  readonly label: string;
  readonly home: string | null;
  /** The home's settings files, when it has several. */
  readonly files: readonly string[];
  readonly also: readonly string[];
  /** Found by its folder's name alone: the first start leaves its switches off. */
  readonly byName: boolean;
  readonly open: Part | undefined;
  readonly tools: Part | undefined;
}

export interface AppsView {
  readonly space: string;
  readonly rows: readonly AppRow[];
  /** Setup's own record when it cannot be read: only turning the tools off works then. */
  readonly record: string | undefined;
}

export interface Outcome {
  readonly key: string;
  readonly part: PartName;
  readonly result: "done" | "failed";
  readonly reason: string | undefined;
  /** open, failed: the key of its entry the service refused (`label`). */
  readonly field: string | undefined;
  /** Tools turned off: the access is off, and the entry stayed in its file (`reason` says why). */
  readonly kept: boolean;
  /** The file an entry stayed in, shown as `~`, when the service names it. */
  readonly file: string | undefined;
  /** Tools, failed: the service did not confirm that the access is off, so the entry stayed too. */
  readonly unconfirmed: boolean;
}

export type Applied =
  | { readonly applied: false; readonly view: AppsView }
  | { readonly applied: true; readonly view: AppsView; readonly outcomes: readonly Outcome[] };

const WORD = /^[a-z_]{1,40}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown, max = 4096): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

const lines = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((line) => text(line) ?? []).slice(0, 200) : [];

/** An action's files and lines, or undefined when it has another shape. */
function changesOf(value: unknown): Changes | undefined {
  if (!isRecord(value) || typeof value["plan"] !== "string") return undefined;
  const file = text(value["file"]) ?? "";
  const files = lines(value["files"]);
  return {
    file,
    files: files.length === 0 ? [file] : files,
    detail: lines(value["detail"]),
    plan: value["plan"],
  };
}

function partOf(value: unknown): Part | undefined {
  if (!isRecord(value)) return undefined;
  const { on, change, why, whyFile, space, off, add } = value;
  const changes = changesOf(value);
  if (typeof on !== "boolean" || changes === undefined) return undefined;
  const named =
    isRecord(space) && typeof space["id"] === "string"
      ? { id: space["id"], name: text(space["name"], 200) ?? null }
      : undefined;
  return {
    ...changes,
    on,
    change: change === "add" || change === "remove" ? change : null,
    why: typeof why === "string" && WORD.test(why) ? why : undefined,
    whyFile: text(whyFile),
    space: named,
    off: changesOf(off),
    add: changesOf(add),
  };
}

/** The service's view, or an error when it has another shape. */
export function viewOf(value: unknown): AppsView {
  if (!isRecord(value) || typeof value["space"] !== "string" || !Array.isArray(value["rows"])) {
    throw new Error("Not a view of the agent apps");
  }
  const rows = value["rows"].flatMap((row): AppRow[] => {
    if (!isRecord(row)) return [];
    const key = text(row["key"], 8192);
    const app = text(row["app"], 40);
    const label = text(row["label"], 200);
    if (key === undefined || app === undefined || label === undefined) return [];
    return [
      {
        key,
        app,
        label,
        home: text(row["home"]) ?? null,
        files: lines(row["files"]),
        also: Array.isArray(row["also"])
          ? row["also"].filter((h): h is string => h === "codex-app" || h === "t3")
          : [],
        byName: row["byName"] === true,
        open: partOf(row["open"]),
        tools: partOf(row["tools"]),
      },
    ];
  });
  return { space: value["space"], rows, record: text(value["record"]) };
}

export function appliedOf(value: unknown): Applied {
  if (!isRecord(value)) throw new Error("Not an answer of the agent apps");
  const view = viewOf(value["view"]);
  if (value["applied"] !== true) return { applied: false, view };
  const outcomes = (Array.isArray(value["outcomes"]) ? value["outcomes"] : []).flatMap(
    (o): Outcome[] =>
      isRecord(o) && typeof o["key"] === "string" && (o["part"] === "open" || o["part"] === "tools")
        ? [
            {
              key: o["key"],
              part: o["part"],
              result: o["result"] === "done" ? "done" : "failed",
              reason:
                typeof o["reason"] === "string" && WORD.test(o["reason"]) ? o["reason"] : undefined,
              field:
                typeof o["field"] === "string" && WORD.test(o["field"]) ? o["field"] : undefined,
              kept: o["kept"] === true,
              file: text(o["file"]),
              unconfirmed: o["unconfirmed"] === true,
            },
          ]
        : [],
  );
  return { applied: true, view, outcomes };
}

/** One switch's place: its row and which of the two. */
export const switchKey = (row: string, part: PartName): string => JSON.stringify([row, part]);

/** What the person chose for a switch: to turn it on, or off. */
export type Action = "add" | "remove";

/**
 * The switches the person chose to change, until Apply. A switch that is not in it stands as the
 * view says.
 */
export type Choices = ReadonlyMap<string, Action>;

/**
 * What an action on a part changes, when the part offers it: turning it over, turning off one that
 * shows off, or writing the entry into a file that has none beside one that shows on.
 */
function offered(found: Part, action: Action): Changes | undefined {
  if (found.change === action) return found;
  if (action === "remove") return found.on ? undefined : found.off;
  return found.on ? found.add : undefined;
}

/**
 * The person's choices as they first see the switches: none in Settings, and at the first start
 * every switch that can be turned on is on, so one press applies the usual choice. A switch with
 * something to know first (one of several Claude Desktop files, a home whose tools were turned off
 * before), or in a folder found by its name alone, is left to the person.
 */
export function initialChoices(view: AppsView, propose: boolean): Map<string, Action> {
  const choices = new Map<string, Action>();
  if (!propose) return choices;
  for (const row of view.rows.filter((r) => !r.byName)) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      if (found?.change === "add" && found.why === undefined) {
        choices.set(switchKey(row.key, part), "add");
      }
    }
  }
  return choices;
}

/** Whether a switch shows on: the person's choice, else how it stands. */
export function shownOn(choices: Choices, row: AppRow | undefined, part: PartName): boolean {
  if (row === undefined) return false;
  const chosen = choices.get(switchKey(row.key, part));
  return chosen === undefined ? (row[part]?.on ?? false) : chosen === "add";
}

/** Whether the person chose to turn off a switch that shows off (its access may still be live). */
export const offChosen = (choices: Choices, row: AppRow, part: PartName): boolean =>
  row[part]?.on === false && choices.get(switchKey(row.key, part)) === "remove";

/** Whether the person chose to write the entry into a file that has none, beside a switch that shows on. */
export const addChosen = (choices: Choices, row: AppRow, part: PartName): boolean =>
  row[part]?.on === true && choices.get(switchKey(row.key, part)) === "add";

/**
 * A switch turned over by the person: back to how it stands is no choice at all. Claude Desktop's
 * settings files that have no entry yet share one instance, so only one of them can take the tools
 * in one apply: turning one on turns the others off. One that has the tools already keeps them
 * until the person turns it off.
 */
export function choose(
  view: AppsView,
  before: Choices,
  row: AppRow,
  part: PartName,
  on: boolean,
): Map<string, Action> {
  const choices = new Map(before);
  const key = switchKey(row.key, part);
  if (row[part]?.on === on) choices.delete(key);
  else choices.set(key, on ? "add" : "remove");
  if (row.app !== "claude-desktop" || part !== "tools" || !on) return choices;
  for (const other of view.rows) {
    if (other.key === row.key || other.app !== "claude-desktop") continue;
    const otherKey = switchKey(other.key, "tools");
    if (choices.get(otherKey) === "add") choices.delete(otherKey);
  }
  return choices;
}

/** Turning off a switch that shows off, or taking that choice back. */
export function chooseOff(
  before: Choices,
  row: AppRow,
  part: PartName,
  off: boolean,
): Map<string, Action> {
  const choices = new Map(before);
  const key = switchKey(row.key, part);
  if (off) choices.set(key, "remove");
  else choices.delete(key);
  return choices;
}

/** Writing the entry into a file that has none, beside a switch that shows on, or taking that back. */
export function chooseAdd(
  before: Choices,
  row: AppRow,
  part: PartName,
  add: boolean,
): Map<string, Action> {
  const choices = new Map(before);
  const key = switchKey(row.key, part);
  if (add) choices.set(key, "add");
  else choices.delete(key);
  return choices;
}

/**
 * The person's choices carried over to a newer view (one that came back because something changed
 * since): each keeps while the newer view still offers it, and every other switch stands as the
 * newer view says, also one another window turned over meanwhile.
 */
export function carryChoices(view: AppsView, before: Choices): Map<string, Action> {
  const choices = new Map<string, Action>();
  for (const row of view.rows) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      const key = switchKey(row.key, part);
      const wanted = before.get(key);
      if (found !== undefined && wanted !== undefined && offered(found, wanted) !== undefined) {
        choices.set(key, wanted);
      }
    }
  }
  return choices;
}

/** A switch the person turned over: what Apply sends, with what the page shows of it. */
export interface Pending {
  readonly row: AppRow;
  readonly part: PartName;
  readonly found: Part;
  readonly on: boolean;
  /** The files that change, the lines written or taken out, and the token Apply sends. */
  readonly what: Changes;
}

/** The choices the view offers: what Apply sends. */
export function pendingOf(view: AppsView, choices: Choices): Pending[] {
  const pending: Pending[] = [];
  for (const row of view.rows) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      const action = choices.get(switchKey(row.key, part));
      if (found === undefined || action === undefined) continue;
      const what = offered(found, action);
      if (what === undefined) continue;
      pending.push({
        row,
        part,
        found,
        on: action === "add",
        what,
      });
    }
  }
  return pending;
}

export async function readApps(api: Api, space: string): Promise<AppsView> {
  return viewOf(await api.agentApps(space));
}

export async function applyApps(
  api: Api,
  space: string,
  pending: readonly Pending[],
): Promise<Applied> {
  return appliedOf(
    await api.applyAgentApps(
      space,
      pending.map((p) => ({ key: p.row.key, part: p.part, on: p.on, plan: p.what.plan })),
    ),
  );
}
