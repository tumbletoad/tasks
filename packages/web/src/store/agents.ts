// The Agents page's part from the Agent Monitor (TTAM): the view the service sends on the feed while
// the tab watches, and what the tab tells the service about itself. The view lives in memory only,
// while an Agents page is mounted: it is never written to the browser's storage.
import {
  MONITOR_ACTIVITIES,
  MONITOR_FAILURES,
  MONITOR_PROVIDERS,
  MONITOR_ROW_KINDS,
  MONITOR_WINDOW_KINDS,
  type AgentsAccount,
  type AgentsNested,
  type AgentsPicture,
  type AgentsSession,
  type AgentsTask,
  type AgentsView,
  type MonitorFailure,
  type MonitorWindow,
} from "@ttasks/contracts/monitor";

export type { AgentsAccount, AgentsNested, AgentsSession, AgentsTask, AgentsView, MonitorWindow };

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const word = <W extends string>(known: readonly W[], v: unknown): W | "unknown" =>
  (known as readonly unknown[]).includes(v) ? (v as W) : "unknown";
const list = <T>(v: unknown, item: (o: Obj) => T): T[] =>
  Array.isArray(v) ? v.filter(isObj).map(item) : [];

function nestedOf(o: Obj): AgentsNested {
  return {
    key: text(o["key"]),
    kind: word(MONITOR_ROW_KINDS, o["kind"]),
    title: text(o["title"]),
    activity: word(MONITOR_ACTIVITIES, o["activity"]),
    ageMs: numOrNull(o["ageMs"]),
  };
}

/** A task as the service names it; null for one of another shape, which then links nothing. */
function taskOf(v: unknown): AgentsTask | null {
  if (!isObj(v)) return null;
  const started = v["started"];
  const fields = [v["space"], v["spaceName"], v["id"], v["ref"]];
  if (
    !fields.every((f) => typeof f === "string") ||
    (started !== "run" && started !== "terminal")
  ) {
    return null;
  }
  return {
    space: text(v["space"]),
    spaceName: text(v["spaceName"]),
    id: text(v["id"]),
    ref: text(v["ref"]),
    started,
  };
}

function sessionOf(o: Obj): AgentsSession {
  return {
    key: text(o["key"]),
    task: taskOf(o["task"]),
    app: word(MONITOR_PROVIDERS, o["app"]),
    appName: text(o["appName"]),
    account: text(o["account"]),
    title: text(o["title"]),
    folder: textOrNull(o["folder"]),
    activity: word(MONITOR_ACTIVITIES, o["activity"]),
    ageMs: numOrNull(o["ageMs"]),
    quietMs: numOrNull(o["quietMs"]),
    nested: list(o["nested"], nestedOf),
  };
}

function windowOf(o: Obj): MonitorWindow {
  return {
    scope: textOrNull(o["scope"]),
    kind: word(MONITOR_WINDOW_KINDS, o["kind"]),
    label: textOrNull(o["label"]),
    usedPercent: num(o["usedPercent"]),
    windowMinutes: numOrNull(o["windowMinutes"]),
    resetsInMs: numOrNull(o["resetsInMs"]),
    limited: o["limited"] === true,
    readingAgeMs: num(o["readingAgeMs"]),
  };
}

function accountOf(o: Obj): AgentsAccount {
  return {
    key: text(o["key"]),
    app: word(MONITOR_PROVIDERS, o["app"]),
    appName: text(o["appName"]),
    account: text(o["account"]),
    plan: textOrNull(o["plan"]),
    windows: list(o["windows"], windowOf),
    readingAgeMs: numOrNull(o["readingAgeMs"]),
    refreshing: o["refreshing"] === true,
    limited: o["limited"] === true,
    failed: o["failed"] === true,
    unavailable: o["unavailable"] === true,
  };
}

function troubleOf(v: unknown): AgentsView["trouble"] | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  switch (v["kind"]) {
    case "slow":
      return { kind: "slow" };
    case "not_installed": {
      const reason = v["reason"];
      return {
        kind: "not_installed",
        reason: reason === "script" || reason === "no_query" ? reason : "not_found",
      };
    }
    case "does_not_fit": {
      const found = v["found"];
      const monitor = v["monitor"];
      return {
        kind: "does_not_fit",
        monitor: monitor === "newer" || monitor === "older" ? monitor : "other_shape",
        found: isObj(found)
          ? { version: text(found["version"]), build: textOrNull(found["build"]) }
          : null,
      };
    }
    case "failed":
      return {
        kind: "failed",
        reason: (MONITOR_FAILURES as readonly unknown[]).includes(v["reason"])
          ? (v["reason"] as MonitorFailure)
          : "exited",
      };
    default:
      return undefined;
  }
}

/** The service's `agents` message; undefined when it has another shape. */
export function parseAgents(message: Obj): AgentsView | undefined {
  const trouble = troubleOf(message["trouble"]);
  if (trouble === undefined) return undefined;
  const p = message["picture"];
  if (p !== null && !isObj(p)) return undefined;
  const picture: AgentsPicture | null =
    p === null
      ? null
      : {
          ageMs: Math.max(0, num(p["ageMs"])),
          settling: p["settling"] === true,
          sessions: list(p["sessions"], sessionOf),
          unseen: list(p["unseen"], (o) => taskOf(o)).filter((t) => t !== null),
          accounts: list(p["accounts"], accountOf),
        };
  return { picture, trouble };
}

export interface AgentsState {
  /** None yet: the tab has not been told. */
  readonly view: AgentsView | undefined;
  /** performance.now() when it arrived: the picture is that much older now. */
  readonly at: number;
  /**
   * The view is the monitor as it is now: the feed that carries it is up and of this page's
   * build, and the monitor answers. Else the page shows it as it was, never in the present.
   */
  readonly current: boolean;
}

const EMPTY: AgentsState = { view: undefined, at: 0, current: false };

/**
 * The newest view the tab was sent, for the page to read. It is current from its arrival until
 * the feed is cut, and the next view after a cut is the first that is current again.
 */
export class AgentsFeed {
  #state: AgentsState = EMPTY;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): AgentsState => this.#state;

  show(view: AgentsView, at = performance.now()): void {
    this.#set({ view, at, current: view.trouble === null });
  }

  /** The feed that carries the view is gone, or of another build: what shows is as it was. */
  cut(): void {
    if (this.#state.current) this.#set({ ...this.#state, current: false });
  }

  clear(): void {
    if (this.#state !== EMPTY) this.#set(EMPTY);
  }

  #set(state: AgentsState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
