// The stand-in agents (stand-in.ts) as a test starts them, and a census of what is still alive,
// read from the operating system without the container: on Linux every process's arguments in
// /proc, on Windows the named pipes each stand-in process listens on.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ContainerSpec } from "../../src/container/index.ts";

/** The stand-in program. */
export const STAND_IN = join(import.meta.dirname, "stand-in.ts");

export type StandInMode =
  | "behave"
  | "fork-late"
  | "detach"
  | "ignore-stop"
  | "hold-pipe"
  | "flood"
  | "die"
  | "handles"
  | "argv";

/** A fresh token: it marks every process of one stand-in tree. */
export const newToken = (): string => randomBytes(8).toString("hex");

/** A container spec that starts stand-in `mode`. */
export function standInSpec(
  name: string,
  mode: StandInMode,
  token: string,
  options: { maxMs?: number; cwd?: string; args?: readonly string[] } = {},
): ContainerSpec {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    name,
    command: process.execPath,
    args: [
      STAND_IN,
      mode,
      `--token=${token}`,
      `--max-ms=${String(options.maxMs ?? 60_000)}`,
      ...(options.args === undefined ? [] : ["--", ...options.args]),
    ],
    cwd: options.cwd ?? import.meta.dirname,
    env,
  };
}

const PIPE_PREFIX = "tasks-test-standin-";

/** The process IDs of the live processes of the stand-in tree marked `token`. */
export function census(token: string): number[] {
  if (process.platform === "win32") {
    const prefix = `${PIPE_PREFIX}${token}-`;
    return readdirSync("\\\\.\\pipe\\")
      .filter((name) => name.startsWith(prefix))
      .map((name) => Number(name.slice(prefix.length)));
  }
  const mark = `--token=${token}`;
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let args: string[];
    try {
      args = readFileSync(join("/proc", entry, "cmdline"), "latin1").split("\0");
    } catch {
      continue;
    }
    if (args.includes(mark)) found.push(Number(entry));
  }
  return found;
}

/** Waits until the census of `token` satisfies `ok`, and returns it; throws after `ms`. */
export async function waitForCensus(
  token: string,
  ok: (pids: number[]) => boolean,
  ms = 15_000,
): Promise<number[]> {
  const deadline = performance.now() + ms;
  for (;;) {
    const pids = census(token);
    if (ok(pids)) return pids;
    if (performance.now() >= deadline) {
      throw new Error(`stand-in census never matched: ${String(pids.length)} alive`);
    }
    await sleep(25);
  }
}
