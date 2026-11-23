// The Agent Monitor (TTAM) as the rest of TTasks reads it: what one snapshot holds, and why there
// is none. The service turns TTAM's own output into these shapes at the boundary
// (service/src/monitor), so the page and the links to tasks read only fields TTasks knows.
//
// Monitor data describes every agent on this computer, other projects' too. It stays in the
// service and the person's own page: it never reaches an agent's tools, a space, a log or another
// machine. Its only free text is a home's label and path, an agent's name and folder, a provider
// TTasks does not know by name, a plan's name and a usage window's scope and label.
//
// An enum value TTasks does not know is `unknown`, never dropped. Times are ages at the moment the
// snapshot was captured, never clock times: the age now is that plus the time since it arrived.

/** The versions of TTAM's lines this build reads: a build fits when its hello names both. */
export const MONITOR_SCHEMA_VERSION = 4;
export const MONITOR_QUERY_VERSION = 1;

export const MONITOR_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type MonitorProvider = (typeof MONITOR_PROVIDERS)[number] | "unknown";

/** `working`: a turn is in progress, not that tokens are being generated now. */
export const MONITOR_ACTIVITIES = [
  "working",
  "idle",
  "waiting",
  "shell",
  "suspended",
  "unknown",
] as const;
export type MonitorActivity = (typeof MONITOR_ACTIVITIES)[number];

/** `session`: a conversation's own agent; the others are agents inside one. */
export const MONITOR_ROW_KINDS = ["session", "subagent", "workflow_agent", "unknown"] as const;
export type MonitorRowKind = (typeof MONITOR_ROW_KINDS)[number];

/** `confirmed`: a live process owns the row. `reported`: its parent says it runs. */
export const MONITOR_LIVENESS = ["confirmed", "reported", "unknown"] as const;
export type MonitorLiveness = (typeof MONITOR_LIVENESS)[number];

export const MONITOR_WINDOW_KINDS = ["session", "weekly", "monthly", "other", "unknown"] as const;
export type MonitorWindowKind = (typeof MONITOR_WINDOW_KINDS)[number];

export const MONITOR_USAGE = ["cached", "live", "unknown"] as const;
export type MonitorUsage = (typeof MONITOR_USAGE)[number];

/** One provider storage location, such as `~/.claude`. */
export interface MonitorHome {
  /** Stable while its path stays the same. */
  readonly id: string;
  readonly provider: MonitorProvider;
  /** The provider as TTAM names it: what the page shows for an `unknown` one. */
  readonly providerName: string;
  readonly label: string;
  /** Absolute, local: how a home TTasks launches agents with is matched to this one. */
  readonly path: string;
  readonly present: boolean;
}

/** One agent: a conversation's own (`session`), or one inside it. */
export interface MonitorAgent {
  /** Stable across snapshots for the same agent in the same process. */
  readonly rowId: string;
  readonly parentRowId: string | null;
  readonly kind: MonitorRowKind;
  readonly provider: MonitorProvider;
  readonly providerName: string;
  readonly homeId: string;
  /** The home's label: which account. */
  readonly profile: string;
  /** With the provider and the home, what a launch of TTasks is joined by. */
  readonly sessionId: string;
  /** An agent inside a conversation: its ID there. null for a `session`. */
  readonly childId: string | null;
  readonly liveness: MonitorLiveness;
  /** The title. */
  readonly name: string;
  /** The working folder. */
  readonly folder: string | null;
  readonly activity: MonitorActivity;
  /** Since the agent started. */
  readonly ageMs: number | null;
  /** Since its latest activity. */
  readonly quietMs: number | null;
}

/** One limit of an account's plan, over one period. */
export interface MonitorWindow {
  /** The part of the account it covers, such as a model family; null for the whole account. */
  readonly scope: string | null;
  readonly kind: MonitorWindowKind;
  readonly label: string | null;
  readonly usedPercent: number;
  readonly windowMinutes: number | null;
  /** Until it resets. Below zero: the reading is from an earlier window. */
  readonly resetsInMs: number | null;
  /** It blocks usage now. */
  readonly limited: boolean;
  readonly readingAgeMs: number;
}

/** The plan usage of one home's account. */
export interface MonitorAccount {
  readonly provider: MonitorProvider;
  readonly providerName: string;
  readonly homeId: string;
  readonly profile: string;
  readonly plan: string | null;
  /** Empty without a reading. */
  readonly windows: readonly MonitorWindow[];
  /** null: there is no reading. */
  readonly readingAgeMs: number | null;
  /** A live query for it runs now: a later snapshot carries its result. */
  readonly refreshing: boolean;
  /** A limit of the account is reached. */
  readonly limited: boolean;
  /** The latest live query failed; a reading shown is older. */
  readonly failed: boolean;
  /** The account has no plan usage to read, such as an API key sign-in. Not a failure. */
  readonly unavailable: boolean;
}

export interface MonitorSnapshot {
  /** It may be incomplete: worth asking again soon. */
  readonly settling: boolean;
  /** Whether TTAM was allowed to start usage queries for it. */
  readonly usage: MonitorUsage;
  /** Rises within one TTAM process; never join counts of two. */
  readonly generation: number;
  /** How long the pass took. */
  readonly collectionMs: number;
  readonly homes: readonly MonitorHome[];
  readonly agents: readonly MonitorAgent[];
  readonly accounts: readonly MonitorAccount[];
}

/** What TTAM's first line says about its build, for display only. */
export interface MonitorBuild {
  readonly version: string;
  readonly build: string | null;
}

/**
 * Why a child failed, as a fixed word: it could not be started, wrote no hello in time or another
 * first line, ended by itself, wrote a line that is not JSON or too long, refused a request, did
 * not answer in time, did not end when its input closed, or the service is stopping.
 */
export const MONITOR_FAILURES = [
  "start_failed",
  "no_hello",
  "exited",
  "bad_output",
  "refused",
  "not_answering",
  "not_ending",
  "closed",
] as const;
export type MonitorFailure = (typeof MONITOR_FAILURES)[number];

/**
 * Why there is no snapshot. `not_installed`: no `ttam` on the PATH, only a script by that name
 * (TTasks runs no script), or a build without `ttam query`. `does_not_fit`: TTAM's versions are
 * newer or older than TTasks reads, or they are the ones it reads and its snapshot has another
 * shape. Only a newer one asks for a newer TTasks.
 */
export type MonitorProblem =
  | { readonly kind: "not_installed"; readonly reason: "not_found" | "script" | "no_query" }
  | {
      readonly kind: "does_not_fit";
      readonly monitor: "newer" | "older" | "other_shape";
      readonly found: MonitorBuild | null;
    }
  | { readonly kind: "failed"; readonly reason: MonitorFailure };

// What the Agents page gets: a picture TTasks shapes from the newest snapshot, sent on the page's
// feed connection only to tabs that look at an Agents page. Ages are as at the capture, and the
// picture's own `ageMs` is how old the capture was when the service sent it: an age on the page is
// the two together plus the page's own time since it arrived.

/** An agent inside a session, one level under it whatever its depth there. */
export interface AgentsNested {
  /** Stable while the same TTAM process sees it. */
  readonly key: string;
  readonly kind: MonitorRowKind;
  readonly title: string;
  readonly activity: MonitorActivity;
  readonly ageMs: number | null;
}

/** One conversation's own agent, with the agents inside it. */
export interface AgentsSession {
  readonly key: string;
  readonly app: MonitorProvider;
  /** The agent app as TTAM names it: what the page shows for an `unknown` one. */
  readonly appName: string;
  /** Which account: the home's label. */
  readonly account: string;
  readonly title: string;
  readonly folder: string | null;
  readonly activity: MonitorActivity;
  readonly ageMs: number | null;
  /** Since its latest activity. */
  readonly quietMs: number | null;
  readonly nested: readonly AgentsNested[];
}

/** One account's plan usage. */
export interface AgentsAccount {
  readonly key: string;
  readonly app: MonitorProvider;
  readonly appName: string;
  readonly account: string;
  readonly plan: string | null;
  readonly windows: readonly MonitorWindow[];
  readonly readingAgeMs: number | null;
  readonly refreshing: boolean;
  readonly limited: boolean;
  readonly failed: boolean;
  readonly unavailable: boolean;
}

export interface AgentsPicture {
  /** How old the capture was when the service sent this. */
  readonly ageMs: number;
  /** TTAM says it may be incomplete. */
  readonly settling: boolean;
  readonly sessions: readonly AgentsSession[];
  readonly accounts: readonly AgentsAccount[];
}

/**
 * The Agents page's part from the monitor. `picture` null: none yet, or the monitor is missing or
 * does not fit. `trouble`: why the picture is not updating, null while it updates.
 */
export interface AgentsView {
  readonly picture: AgentsPicture | null;
  readonly trouble: { readonly kind: "slow" } | MonitorProblem | null;
}

/** What a tab tells the service about itself, on every change and after every reconnect. */
export interface AgentsWatch {
  /** An Agents page is mounted. */
  readonly agents: boolean;
  /** The tab is visible. */
  readonly visible: boolean;
  /** Its window has the focus. */
  readonly focused: boolean;
}
