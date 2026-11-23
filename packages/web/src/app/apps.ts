// This machine's agent apps as the page reads them (the service's hub/agent-apps.ts): each answer
// is checked by its shape before the page uses it. Each row has up to two switches; what the
// person turns over is sent with the token its view showed, and the service writes it only when
// nothing changed since.
import type { Api } from "../api.ts";

export type PartName = "open" | "tools";

export interface Part {
  readonly on: boolean;
  /** What turning it over does; null when the page cannot. */
  readonly change: "add" | "remove" | null;
  readonly why: string | undefined;
  /** The file that changes, the home shown as `~`. */
  readonly file: string;
  /** Exactly what changes in `file`: the lines written or taken out. */
  readonly detail: readonly string[];
  readonly plan: string;
  /** tools: the space its entry names. */
  readonly space: { readonly id: string; readonly name: string | null } | undefined;
}

export interface AppRow {
  readonly key: string;
  readonly app: string;
  readonly label: string;
  readonly home: string | null;
  readonly also: readonly string[];
  readonly open: Part | undefined;
  readonly tools: Part | undefined;
}

export interface AppsView {
  readonly space: string;
  readonly rows: readonly AppRow[];
}

export interface Outcome {
  readonly key: string;
  readonly part: PartName;
  readonly result: "done" | "failed";
  readonly reason: string | undefined;
  /** Tools turned off: the access is off, and the entry stayed in its file (`reason` says why). */
  readonly kept: boolean;
}

export type Applied =
  | { readonly applied: false; readonly view: AppsView }
  | { readonly applied: true; readonly view: AppsView; readonly outcomes: readonly Outcome[] };

const WORD = /^[a-z_]{1,40}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown, max = 4096): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

function partOf(value: unknown): Part | undefined {
  if (!isRecord(value)) return undefined;
  const { on, change, why, file, detail, plan, space } = value;
  if (typeof on !== "boolean" || typeof plan !== "string") return undefined;
  const named =
    isRecord(space) && typeof space["id"] === "string"
      ? { id: space["id"], name: text(space["name"], 200) ?? null }
      : undefined;
  return {
    on,
    change: change === "add" || change === "remove" ? change : null,
    why: typeof why === "string" && WORD.test(why) ? why : undefined,
    file: text(file) ?? "",
    detail: Array.isArray(detail) ? detail.flatMap((line) => text(line) ?? []).slice(0, 200) : [],
    plan,
    space: named,
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
        also: Array.isArray(row["also"])
          ? row["also"].filter((h): h is string => h === "codex-app" || h === "t3")
          : [],
        open: partOf(row["open"]),
        tools: partOf(row["tools"]),
      },
    ];
  });
  return { space: value["space"], rows };
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
              kept: o["kept"] === true,
            },
          ]
        : [],
  );
  return { applied: true, view, outcomes };
}

/** One switch's place: its row and which of the two. */
export const switchKey = (row: string, part: PartName): string => JSON.stringify([row, part]);

/** Where each switch stands for the person: on or off, as they set it before Apply. */
export type Choices = ReadonlyMap<string, boolean>;

/**
 * The switches as a person first sees them: as they stand, and, when `propose` is set (the first
 * start), every switch that can be turned on is on, so one press applies the usual choice. A switch
 * with something to know first (one of several Claude Desktop files) is left to the person.
 */
export function initialChoices(view: AppsView, propose: boolean): Map<string, boolean> {
  const choices = new Map<string, boolean>();
  for (const row of view.rows) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      if (found === undefined) continue;
      const usual = propose && found.change === "add" && found.why === undefined;
      choices.set(switchKey(row.key, part), usual ? true : found.on);
    }
  }
  return choices;
}

/**
 * A switch turned over by the person. Claude Desktop's settings files that have no entry yet share
 * one instance, so only one of them can take the tools in one apply: turning one on turns the
 * others off. One that has the tools already keeps them until the person turns it off.
 */
export function choose(
  view: AppsView,
  before: Choices,
  row: AppRow,
  part: PartName,
  on: boolean,
): Map<string, boolean> {
  const choices = new Map(before).set(switchKey(row.key, part), on);
  if (row.app !== "claude-desktop" || part !== "tools" || !on) return choices;
  for (const other of view.rows) {
    const tools = other.tools;
    if (other.key === row.key || other.app !== "claude-desktop" || tools === undefined) continue;
    if (!tools.on) choices.set(switchKey(other.key, "tools"), false);
  }
  return choices;
}

/**
 * The person's choices carried over to a newer view (one that came back because something changed
 * since): each switch keeps the person's choice while it can still be made, else stands as it is.
 */
export function carryChoices(view: AppsView, before: Choices): Map<string, boolean> {
  const choices = initialChoices(view, false);
  for (const row of view.rows) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      const key = switchKey(row.key, part);
      const wanted = before.get(key);
      if (found === undefined || wanted === undefined || wanted === found.on) continue;
      if (found.change === (wanted ? "add" : "remove")) choices.set(key, wanted);
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
}

/** The switches that differ from how they stand and that the page can turn over. */
export function pendingOf(view: AppsView, choices: Choices): Pending[] {
  const pending: Pending[] = [];
  for (const row of view.rows) {
    for (const part of ["open", "tools"] as const) {
      const found = row[part];
      const on = choices.get(switchKey(row.key, part));
      if (found === undefined || on === undefined || on === found.on) continue;
      if (found.change !== (on ? "add" : "remove")) continue;
      pending.push({ row, part, found, on });
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
      pending.map((p) => ({ key: p.row.key, part: p.part, on: p.on, plan: p.found.plan })),
    ),
  );
}
