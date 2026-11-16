// A run's files in machine state, `<state>/runs/<run id>/`, which the space never holds:
// - `answer.json`: the agent's last answer-bearing event, replaced whole (temporary file and
//   rename) as each one is parsed, so a crash of the service keeps the last one whose write ended.
//   The next start copies it into the run's record.
// - `stdout.jsonl` and `stderr.log`: the agent's raw output for diagnosis, up to their caps.
// Folders are 0700 and files 0600 on Linux and macOS, made through packages/files. On Windows they
// inherit the access list of the state folder in the person's profile, as every file of Tasks does.
import { closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, createFile, makeDir, writeAll } from "@tasks/files";
import { ANSWER_CAP_BYTES } from "@tasks/contracts/runs";

/** The folder under `<state>` that holds one folder per run. */
export const RUNS_FOLDER = "runs";

export const ANSWER_FILE = "answer.json";
export const STDOUT_FILE = "stdout.jsonl";
export const STDERR_FILE = "stderr.log";

/** How much raw output a run keeps for diagnosis. The parser reads every byte past these. */
export const STDOUT_CAP_BYTES = 20 * 1024 * 1024;
export const STDERR_CAP_BYTES = 2 * 1024 * 1024;

/** An answer as the run's folder keeps it. */
export interface SavedAnswer {
  readonly text: string;
  /** The agent finished its turn with it. */
  readonly final: boolean;
  /** It was longer than ANSWER_CAP_BYTES and is cut. */
  readonly cut: boolean;
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
  saveAnswer(id: string, answer: SavedAnswer): void;
  readAnswer(id: string): SavedAnswer | undefined;
  logs(id: string): RunLogs;
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
    const text = JSON.stringify({ final: answer.final, cut: answer.cut, text: answer.text });
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
    const { text, final, cut } = value as Record<string, unknown>;
    if (typeof text !== "string" || typeof final !== "boolean" || typeof cut !== "boolean") {
      return undefined;
    }
    // Written by this module within the cap; a longer one was changed by something else.
    if (Buffer.byteLength(text, "utf8") > ANSWER_CAP_BYTES) return undefined;
    return { text, final, cut };
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
