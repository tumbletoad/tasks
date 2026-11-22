// A run's files in machine state, `<state>/runs/<run id>/`, which the space never holds:
// - `answer.json`: the agent's last answer, replaced whole (temporary file and rename) as each
//   one comes, so a crash of the service keeps the last one whose write ended; and once the work
//   settled, the work's result with it, before anything of the run is closed. The next start
//   copies it into the run's record.
// - `stdout.jsonl` and `stderr.log`: the agent's raw output for diagnosis, up to their caps. It is
//   task text, like the answer, and goes with the folder.
// - `tools.json`: Tasks' tools for an agent that takes them from a file (Claude Code), with the
//   run's ticket, which no command line may carry. The ticket is good only while the run runs.
// Folders are 0700 and files 0600 on Linux and macOS, made through packages/files. On Windows they
// inherit the access list of the state folder in the person's profile, as every file of TTasks does.
// The supervisor removes old folders (supervisor.ts retain); nothing else removes one.
import { closeSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, createFile, makeDir, removeStaleTemps, writeAll } from "@ttasks/files";
import {
  ANSWER_CAP_BYTES,
  OUTCOME_REASONS,
  TEXT_CAP_BYTES,
  type OutcomeReason,
} from "@ttasks/contracts/runs";

/** The folder under `<state>` that holds one folder per run. */
export const RUNS_FOLDER = "runs";

export const ANSWER_FILE = "answer.json";
export const STDOUT_FILE = "stdout.jsonl";
export const STDERR_FILE = "stderr.log";
/** The tools file of an agent that takes its tools from a file: it holds the run's ticket. */
export const TOOLS_FILE = "tools.json";
const PRIVATE_FILES = [TOOLS_FILE] as const;

/** How much raw output a run keeps for diagnosis. The parser reads every byte past these. */
export const STDOUT_CAP_BYTES = 20 * 1024 * 1024;
export const STDERR_CAP_BYTES = 2 * 1024 * 1024;

/** An answer as the run's folder keeps it, with the work's result once the work settled. */
export interface SavedAnswer {
  readonly text: string | null;
  /** The agent finished its turn with it. */
  readonly final: boolean;
  /** It was longer than ANSWER_CAP_BYTES and is cut. */
  readonly cut: boolean;
  /** How the work ended, once it settled. */
  readonly outcome?: OutcomeReason;
  /** The agent's own words about what went wrong, once the work settled. */
  readonly error?: string | null;
}

/** A run's raw output files, written as the output comes, each up to its cap. */
export interface RunLogs {
  stdout(chunk: Uint8Array): void;
  stderr(chunk: Uint8Array): void;
  close(): void;
}

/** What the run host keeps of a run in machine state. RunFiles keeps it in the run's folder. */
export interface RunFolders {
  /** Makes the run's folder, before its container starts. */
  prepare(id: string): void;
  /** Replaces the saved answer. Throws when it cannot be written (a full disk, for one). */
  saveAnswer(id: string, answer: SavedAnswer): void;
  /** The saved answer, or undefined when there is none or it is not one. */
  readAnswer(id: string): SavedAnswer | undefined;
  /** The run's raw output files. */
  logs(id: string): RunLogs;
  /** Removes what a crash left of a write: a temporary file beside the answer. */
  removeTemps(id: string): void;
}

const RUN_ID = /^ru_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** One capped file, opened on its first byte. A write that fails stops it: it is diagnosis only. */
class CappedFile {
  readonly #path: string;
  readonly #cap: number;
  #fd: number | undefined;
  #written = 0;
  #broken = false;

  constructor(path: string, cap: number) {
    this.#path = path;
    this.#cap = cap;
  }

  write(chunk: Uint8Array): void {
    if (this.#broken || this.#written >= this.#cap) return;
    const part = chunk.subarray(0, this.#cap - this.#written);
    try {
      this.#fd ??= createFile(this.#path, 0o600, "wx");
      writeAll(this.#fd, part);
      this.#written += part.length;
    } catch {
      this.#broken = true;
    }
  }

  close(): void {
    if (this.#fd === undefined) return;
    try {
      closeSync(this.#fd);
    } catch {
      // Closing a descriptor of a file nobody reads again: nothing to keep.
    }
    this.#fd = undefined;
  }
}

export class RunFiles implements RunFolders {
  /** `<state>/runs`. */
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  folder(id: string): string {
    if (!RUN_ID.test(id)) throw new Error("Not a run ID");
    return join(this.root, id);
  }

  prepare(id: string): void {
    makeDir(this.root, 0o700);
    makeDir(this.folder(id), 0o700);
  }

  saveAnswer(id: string, answer: SavedAnswer): void {
    const text = JSON.stringify({
      final: answer.final,
      cut: answer.cut,
      text: answer.text,
      ...(answer.outcome === undefined ? {} : { outcome: answer.outcome, error: answer.error }),
    });
    atomicWrite(join(this.folder(id), ANSWER_FILE), text, 0o600);
  }

  readAnswer(id: string): SavedAnswer | undefined {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(this.folder(id), ANSWER_FILE), "utf8"));
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const { text, final, cut, outcome, error } = value as Record<string, unknown>;
    if (
      (typeof text !== "string" && text !== null) ||
      typeof final !== "boolean" ||
      typeof cut !== "boolean"
    ) {
      return undefined;
    }
    // Written by this module within the caps; a longer one was changed by something else.
    if (text !== null && Buffer.byteLength(text, "utf8") > ANSWER_CAP_BYTES) return undefined;
    if (outcome === undefined) return { text, final, cut };
    if (!(OUTCOME_REASONS as readonly unknown[]).includes(outcome)) return undefined;
    if (
      error !== null &&
      (typeof error !== "string" || Buffer.byteLength(error) > TEXT_CAP_BYTES)
    ) {
      return undefined;
    }
    return { text, final, cut, outcome: outcome as OutcomeReason, error };
  }

  removeTemps(id: string): void {
    removeStaleTemps(this.folder(id), [ANSWER_FILE, ...PRIVATE_FILES]);
  }

  /**
   * Writes one of the run's private files whole, such as the tools file an agent is given, which
   * holds the run's ticket. Returns its path.
   */
  writePrivate(id: string, name: (typeof PRIVATE_FILES)[number], text: string): string {
    const path = join(this.folder(id), name);
    atomicWrite(path, text, 0o600);
    return path;
  }

  /** Whether the run's answer file is there, or could not be told (any error but its absence). */
  hasAnswer(id: string): boolean {
    try {
      lstatSync(join(this.folder(id), ANSWER_FILE));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  /** The run folders there are, each with when it last changed (ms), in no order. */
  list(): { readonly id: string; readonly changedAt: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const found: { id: string; changedAt: number }[] = [];
    for (const name of names) {
      if (!RUN_ID.test(name)) continue;
      try {
        const stat = lstatSync(join(this.root, name));
        if (stat.isDirectory()) found.push({ id: name, changedAt: stat.mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
    return found;
  }

  /** Removes a run's folder and everything in it. */
  remove(id: string): void {
    rmSync(this.folder(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  logs(id: string): RunLogs {
    const folder = this.folder(id);
    const out = new CappedFile(join(folder, STDOUT_FILE), STDOUT_CAP_BYTES);
    const err = new CappedFile(join(folder, STDERR_FILE), STDERR_CAP_BYTES);
    return {
      stdout: (chunk) => {
        out.write(chunk);
      },
      stderr: (chunk) => {
        err.write(chunk);
      },
      close: () => {
        out.close();
        err.close();
      },
    };
  }
}
