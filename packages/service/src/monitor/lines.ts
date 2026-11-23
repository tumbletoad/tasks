// TTAM's lines, read into TTasks's shapes (@ttasks/contracts/monitor). Only the fields TTasks
// reads are looked at: an unknown field is ignored and an unknown enum value becomes `unknown`.
// A field TTasks reads that is missing or of another type makes the whole snapshot one that does
// not fit (ShapeError), never an emptier one.
import {
  MONITOR_ACTIVITIES,
  MONITOR_LIVENESS,
  MONITOR_PROVIDERS,
  MONITOR_ROW_KINDS,
  MONITOR_USAGE,
  MONITOR_WINDOW_KINDS,
  type MonitorAccount,
  type MonitorAgent,
  type MonitorBuild,
  type MonitorHome,
  type MonitorProvider,
  type MonitorSnapshot,
  type MonitorWindow,
} from "@ttasks/contracts/monitor";

/** A field TTasks reads is not what the schema says. */
export class ShapeError extends Error {}

type Obj = Readonly<Record<string, unknown>>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function obj(value: unknown): Obj {
  if (!isObj(value)) throw new ShapeError();
  return value;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new ShapeError();
  return value;
}

const strOrNull = (value: unknown): string | null => (value === null ? null : str(value));

function int(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new ShapeError();
  return value as number;
}

const intOrNull = (value: unknown): number | null => (value === null ? null : int(value));

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ShapeError();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ShapeError();
  return value;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new ShapeError();
  return value;
}

/** A value of an open set: one TTasks knows, else `unknown`. */
function word<const W extends string>(known: readonly W[], value: unknown): W | "unknown" {
  const text = str(value);
  return (known as readonly string[]).includes(text) ? (text as W) : "unknown";
}

const provider = (value: unknown): MonitorProvider => word(MONITOR_PROVIDERS, value);

/** From `at` to the capture; below zero counts as zero. */
const ageOf = (captured: number, at: number | null): number | null =>
  at === null ? null : Math.max(0, captured - at);

function home(value: unknown): MonitorHome {
  const h = obj(value);
  return {
    id: str(h["id"]),
    provider: provider(h["provider"]),
    providerName: str(h["provider"]),
    label: str(h["label"]),
    path: str(h["path"]),
    present: bool(h["present"]),
  };
}

function agent(captured: number, value: unknown): MonitorAgent {
  const a = obj(value);
  return {
    rowId: str(a["row_id"]),
    parentRowId: strOrNull(a["parent_row_id"]),
    kind: word(MONITOR_ROW_KINDS, a["kind"]),
    provider: provider(a["provider"]),
    providerName: str(a["provider"]),
    homeId: str(a["home_id"]),
    profile: str(a["profile"]),
    sessionId: str(obj(a["conversation"])["session_id"]),
    childId: strOrNull(a["child_id"]),
    liveness: word(MONITOR_LIVENESS, a["liveness"]),
    name: str(a["name"]),
    folder: strOrNull(a["project"]),
    activity: word(MONITOR_ACTIVITIES, a["activity"]),
    ageMs: ageOf(captured, intOrNull(a["started_at_ms"])),
    quietMs: ageOf(captured, intOrNull(a["last_activity_ms"])),
  };
}

function usageWindow(captured: number, value: unknown): MonitorWindow {
  const w = obj(value);
  const resets = intOrNull(w["resets_at_ms"]);
  return {
    scope: strOrNull(w["scope"]),
    kind: word(MONITOR_WINDOW_KINDS, w["kind"]),
    label: strOrNull(w["label"]),
    usedPercent: num(w["used_percent"]),
    windowMinutes: intOrNull(w["window_minutes"]),
    resetsInMs: resets === null ? null : resets - captured,
    limited: strOrNull(w["limited"]) !== null,
    readingAgeMs: ageOf(captured, int(w["observed_at_ms"])) ?? 0,
  };
}

function account(captured: number, value: unknown): MonitorAccount {
  const a = obj(value);
  const status = obj(a["status"]);
  return {
    provider: provider(a["provider"]),
    providerName: str(a["provider"]),
    homeId: str(a["home_id"]),
    profile: str(a["profile"]),
    plan: strOrNull(a["plan"]),
    windows: list(a["windows"]).map((w) => usageWindow(captured, w)),
    readingAgeMs: ageOf(captured, intOrNull(a["observed_at_ms"])),
    refreshing: bool(status["refreshing"]),
    limited: strOrNull(status["limited"]) !== null,
    failed: strOrNull(status["error"]) !== null,
    unavailable: strOrNull(status["unavailable"]) !== null,
  };
}

/** A snapshot line's `snapshot`, with the line's own `settling` and `usage`. */
export function readSnapshot(line: Obj, schemaVersion: number): MonitorSnapshot {
  const s = obj(line["snapshot"]);
  if (s["schema_version"] !== schemaVersion) throw new ShapeError();
  const captured = int(s["captured_at_ms"]);
  return {
    settling: bool(line["settling"]),
    usage: word(MONITOR_USAGE, line["usage"]),
    generation: int(s["generation"]),
    collectionMs: int(s["collection_ms"]),
    homes: list(s["homes"]).map(home),
    agents: list(s["agents"]).map((a) => agent(captured, a)),
    accounts: list(s["account_usage"]).map((a) => account(captured, a)),
  };
}

/** One line TTAM wrote, by its type. A line that is no JSON object is `undefined`. */
export type Line =
  | {
      readonly type: "hello";
      readonly schemaVersion: unknown;
      readonly queryVersion: unknown;
      readonly build: MonitorBuild | null;
    }
  | { readonly type: "snapshot"; readonly id: unknown; readonly line: Obj }
  | { readonly type: "error"; readonly id: unknown; readonly code: unknown }
  | { readonly type: "other" };

export function readLine(text: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(value)) return undefined;
  switch (value["type"]) {
    case "hello": {
      const version = value["version"];
      const build = value["build"];
      return {
        type: "hello",
        schemaVersion: value["schema_version"],
        queryVersion: value["query_version"],
        build:
          typeof version === "string" && (build === null || typeof build === "string")
            ? { version, build }
            : null,
      };
    }
    case "snapshot":
      return { type: "snapshot", id: value["id"], line: value };
    case "error":
      return { type: "error", id: value["id"], code: value["code"] };
    default:
      return { type: "other" };
  }
}
