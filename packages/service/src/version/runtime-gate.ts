// The runtime gate (A2 3.12.1): the Node this process runs on is the build's pinned runtime, and
// its SQLite can hold a space. The build runs it inside every version folder it makes, through the
// version's own launcher, and blocks the build when it fails (A2 3.12.8); doctor runs it as its
// `runtime` row (A2 3.13), and the candidate's self-test of an install or update with it (A2 3.12.6).
//
//   node-version         the runtime is the pinned Node
//   sqlite-version       process.versions.sqlite is the pinned SQLite
//   sqlite-capabilities  storage's start-up check passes on the default driver: FTS5 compiled in and
//                        answering MATCH, the JSON functions, STRICT tables and the backup API, and
//                        the driver's own SQLite is the pinned one too
//   launcher-flags       the flags the launchers pass reached Node: --report-exclude-env, and with it
//                        Node's diagnostic reports leave the environment out
//
// The SQLite probes use private in-memory databases only (storage's CheckedDriver.check): no file
// is opened. Every detail is a version or a fixed sentence, never a path or a value of the
// environment.
import {
  CheckedDriver,
  DEFAULT_DRIVER,
  loadDriver,
  StorageError,
  type SqliteDriver,
} from "@ttasks/storage";

/** The flags both launchers put before the entry (A2 3.12.3). */
export const LAUNCHER_FLAGS: readonly string[] = ["--report-exclude-env"];

export const GATE_CHECKS = [
  "node-version",
  "sqlite-version",
  "sqlite-capabilities",
  "launcher-flags",
] as const;
export type GateCheckName = (typeof GATE_CHECKS)[number];

export interface GateCheck {
  readonly check: GateCheckName;
  readonly ok: boolean;
  readonly detail: string;
}

/** What the version folder pins (its manifest.json's `node` and `sqlite`). */
export interface GateExpectations {
  readonly node: string;
  readonly sqlite: string;
}

/** What the gate reads from the process. Tests pass their own. */
export interface GateFacts {
  /** `process.version`, for example `v26.13.1`. */
  readonly nodeVersion: string;
  /** `process.versions.sqlite`. */
  readonly sqliteVersion: string | undefined;
  readonly execArgv: readonly string[];
  /** Whether Node's diagnostic reports leave the environment out. */
  readonly reportExcludesEnv: () => boolean;
}

export function processFacts(): GateFacts {
  return {
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    execArgv: process.execArgv,
    reportExcludesEnv: () => {
      if (!process.report.excludeEnv) return false;
      // eslint-disable-next-line no-restricted-syntax -- the gate runs in doctor's own process, which starts no worker thread
      const report = process.report.getReport();
      return !("environmentVariables" in report);
    },
  };
}

async function sqliteCapabilities(
  expect: GateExpectations,
  driver: () => Promise<SqliteDriver>,
): Promise<GateCheck> {
  try {
    const checked = await CheckedDriver.check(await driver());
    const { sqliteVersion, compileOptions } = checked.report;
    if (sqliteVersion !== expect.sqlite) {
      return {
        check: "sqlite-capabilities",
        ok: false,
        detail: `The driver's SQLite is ${sqliteVersion}, the build pins ${expect.sqlite}.`,
      };
    }
    if (!compileOptions.includes("ENABLE_FTS5")) {
      return {
        check: "sqlite-capabilities",
        ok: false,
        detail: "SQLite does not list ENABLE_FTS5 among its compile options.",
      };
    }
    return {
      check: "sqlite-capabilities",
      ok: true,
      detail: `SQLite ${sqliteVersion} with FTS5, JSON, STRICT tables and the backup API.`,
    };
  } catch (error) {
    return {
      check: "sqlite-capabilities",
      ok: false,
      // Storage's start-up check names each missing capability in fixed words.
      detail:
        error instanceof StorageError ? error.message : "The SQLite start-up check could not run.",
    };
  }
}

function launcherFlags(facts: GateFacts): GateCheck {
  const missing = LAUNCHER_FLAGS.filter((flag) => !facts.execArgv.includes(flag));
  if (missing.length > 0) {
    return {
      check: "launcher-flags",
      ok: false,
      detail: `Node was started without ${missing.join(" ")}: not through a launcher.`,
    };
  }
  let excluded: boolean;
  try {
    excluded = facts.reportExcludesEnv();
  } catch {
    excluded = false;
  }
  return excluded
    ? {
        check: "launcher-flags",
        ok: true,
        detail: `${LAUNCHER_FLAGS.join(" ")}: reports leave the environment out.`,
      }
    : {
        check: "launcher-flags",
        ok: false,
        detail: "Node's diagnostic reports still include the environment.",
      };
}

/** Runs every check of the gate, in GATE_CHECKS order. The gate passes when every check is ok. */
export async function runtimeGate(
  expect: GateExpectations,
  facts: GateFacts = processFacts(),
  driver: () => Promise<SqliteDriver> = () => loadDriver(DEFAULT_DRIVER),
): Promise<GateCheck[]> {
  const node = `v${expect.node}`;
  return [
    facts.nodeVersion === node
      ? { check: "node-version", ok: true, detail: `Node ${node}.` }
      : {
          check: "node-version",
          ok: false,
          detail: `Node is ${facts.nodeVersion}, the build pins ${node}.`,
        },
    facts.sqliteVersion === expect.sqlite
      ? { check: "sqlite-version", ok: true, detail: `Node's SQLite ${expect.sqlite}.` }
      : {
          check: "sqlite-version",
          ok: false,
          detail: `Node's SQLite is ${String(facts.sqliteVersion)}, the build pins ${expect.sqlite}.`,
        },
    await sqliteCapabilities(expect, driver),
    launcherFlags(facts),
  ];
}
