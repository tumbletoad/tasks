// Codex's reference match (A4 3.4.3, A4 5.1 "Codex reference match"): fake session folders in a
// temporary Codex home with another folder, the same folder without the reference, a compressed
// file, a file from before the launch, a link, and two launches in one folder. Only the exact
// match is accepted, and nothing older than the launch is read. Fixture data only.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PRODUCT_NAME } from "@tasks/brand";
import { launchRefCheck } from "../src/intents.ts";
import {
  dayFolders,
  matchRollout,
  readRollout,
  ReferenceMatch,
  ROLLOUT_READ_BYTES,
  type MatchTarget,
} from "../src/routes/codex-match.ts";

const REF = `L7KQ2${launchRefCheck("7KQ2") ?? ""}`;
const OTHER = `LZZZZ${launchRefCheck("ZZZZ") ?? ""}`;
const FOLDER = process.platform === "win32" ? "C:\\work\\lumen\\portal" : "/work/lumen/portal";
const TARGET: MatchTarget = { folder: FOLDER, reference: REF, platform: process.platform };
const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** A session file as A4 3.4.3 describes Codex's: its session record, then the messages. */
function rollout(
  options: { thread?: string; cwd?: string; prompt?: string; injected?: boolean } = {},
): string {
  const lines: unknown[] = [
    {
      timestamp: "2026-11-14T08:00:00.000Z",
      type: "session_meta",
      payload: { id: options.thread ?? THREAD, cwd: options.cwd ?? FOLDER, originator: "codex" },
    },
  ];
  if (options.injected !== false) {
    // What Codex adds itself before the person's prompt: never the reference.
    lines.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }],
      },
    });
  }
  if (options.prompt !== undefined) {
    lines.push({ type: "event_msg", payload: { type: "user_message", message: options.prompt } });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const brief = (ref: string): string =>
  `${PRODUCT_NAME} task M-14 "Fix" (launch ${ref}).\nRead the task.`;

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tasks-codex-match-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const dayFolder = (at: number): string => {
  const day = dayFolders(at)[0] ?? "";
  const folder = join(home, "sessions", ...day.split("/"));
  mkdirSync(folder, { recursive: true });
  return folder;
};

describe("[A4.5.routes.codex-match] Codex's reference match: only this launch's session file, only new files", () => {
  test("a file matches only with this launch's folder and its reference in a user message", () => {
    expect(matchRollout(rollout({ prompt: brief(REF) }), TARGET)).toBe(THREAD);
    // Another folder, the same folder without the reference, another launch's reference.
    expect(
      matchRollout(rollout({ cwd: "/work/other", prompt: brief(REF) }), TARGET),
    ).toBeUndefined();
    expect(matchRollout(rollout({ prompt: "Hello" }), TARGET)).toBeUndefined();
    expect(matchRollout(rollout({ prompt: brief(OTHER) }), TARGET)).toBeUndefined();
    // A prompt still to come is pending; a file full without the reference is another's.
    expect(readRollout(rollout(), TARGET, false)).toEqual({ kind: "pending" });
    expect(readRollout(rollout(), TARGET, true)).toEqual({ kind: "other" });
    // A user message before any session record, or a session record of another shape.
    const noMeta = `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: brief(REF) } })}\n`;
    expect(readRollout(noMeta, TARGET, false)).toEqual({ kind: "other" });
    expect(
      matchRollout(rollout({ thread: "not an id!", prompt: brief(REF) }), TARGET),
    ).toBeUndefined();
    // A cut last line is not read; noise lines are skipped.
    expect(matchRollout(`garbage\n${rollout({ prompt: brief(REF) })}{"type":`, TARGET)).toBe(
      THREAD,
    );
    // On Windows the folder matches without case, elsewhere exactly.
    const cased = rollout({ cwd: FOLDER.toUpperCase(), prompt: brief(REF) });
    expect(matchRollout(cased, TARGET) === THREAD).toBe(process.platform === "win32");
  });

  test("in a Codex home: older files, compressed files, links and another launch's file are never taken", () => {
    const at = Date.now();
    const folder = dayFolder(at);
    // There before the launch, even though it would match: never read.
    writeFileSync(
      join(folder, "rollout-before.jsonl"),
      rollout({ thread: "old", prompt: brief(REF) }),
    );
    const watch = new ReferenceMatch(home, TARGET, at);
    expect(watch.look(at)).toBeUndefined();
    // New: a compressed file, another folder's, another launch's in the same folder, a link.
    writeFileSync(
      join(folder, "rollout-z.jsonl.zst"),
      rollout({ thread: "zst", prompt: brief(REF) }),
    );
    writeFileSync(
      join(folder, "rollout-a.jsonl"),
      rollout({ thread: "a", cwd: "/elsewhere", prompt: brief(REF) }),
    );
    writeFileSync(join(folder, "rollout-b.jsonl"), rollout({ thread: "b", prompt: brief(OTHER) }));
    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, rollout({ thread: "link", prompt: brief(REF) }));
    try {
      symlinkSync(outside, join(folder, "rollout-c.jsonl"), "file");
    } catch {
      // Windows without the privilege to make a file link: the rest still holds.
    }
    // This launch's, with its prompt still to come.
    writeFileSync(join(folder, "rollout-d.jsonl"), rollout());
    expect(watch.look(at + 1000)).toBeUndefined();
    // The prompt arrives: the pending file is read again and matches.
    writeFileSync(join(folder, "rollout-d.jsonl"), rollout({ prompt: brief(REF) }));
    expect(watch.look(at + 2000)).toBe(THREAD);
  });

  test("two launches in one folder each find their own file", () => {
    const at = Date.now();
    const folder = dayFolder(at);
    const mine = new ReferenceMatch(home, TARGET, at);
    const theirs = new ReferenceMatch(home, { ...TARGET, reference: OTHER }, at);
    writeFileSync(
      join(folder, "rollout-1.jsonl"),
      rollout({ thread: "first", prompt: brief(OTHER) }),
    );
    writeFileSync(
      join(folder, "rollout-2.jsonl"),
      rollout({ thread: "second", prompt: brief(REF) }),
    );
    expect(mine.look(at)).toBe("second");
    expect(theirs.look(at)).toBe("first");
  });

  test("the reference counts only in the brief's own place: not in a title, not in what Codex adds itself", () => {
    // Another launch's brief whose title names this launch's reference: the title is task data.
    const quoting = `${PRODUCT_NAME} task M-14 "Follow up launch ${REF} (launch ${REF})." (launch ${OTHER}).\nRead the task.`;
    expect(matchRollout(rollout({ prompt: quoting }), TARGET)).toBeUndefined();
    expect(readRollout(rollout({ prompt: quoting }), TARGET, false)).toEqual({ kind: "other" });
    // The folder's instructions, which Codex adds as a user message, name the reference.
    const injected = (text: string): string =>
      `${JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })}\n`;
    const agents = `<user_instructions>\nLaunch ${REF} is the one to resume.\n</user_instructions>`;
    const withAgents = rollout({ injected: false }) + injected(agents);
    expect(readRollout(withAgents, TARGET, false)).toEqual({ kind: "pending" });
    expect(
      matchRollout(
        withAgents +
          `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: brief(OTHER) } })}\n`,
        TARGET,
      ),
    ).toBeUndefined();
    // A brief with the reference anywhere but its first line's place is not this launch's.
    expect(
      matchRollout(rollout({ prompt: `Please look.\n${brief(REF)}` }), TARGET),
    ).toBeUndefined();
    // This launch's own brief, with the person's words after it (the assisted open), matches.
    expect(matchRollout(rollout({ prompt: `${brief(REF)}\nAnd check the tests.` }), TARGET)).toBe(
      THREAD,
    );
  });

  test("two session files that both hold this launch's brief: neither is taken, and the watch ends", () => {
    const at = Date.now();
    const folder = dayFolder(at);
    const watch = new ReferenceMatch(home, TARGET, at);
    writeFileSync(
      join(folder, "rollout-1.jsonl"),
      rollout({ thread: "first", prompt: brief(REF) }),
    );
    writeFileSync(
      join(folder, "rollout-2.jsonl"),
      rollout({ thread: "second", prompt: brief(REF) }),
    );
    expect(watch.look(at)).toBeUndefined();
    expect(watch.settled).toBe(true);
    expect(watch.look(at + 1000)).toBeUndefined();
  });

  test("only the first 64 KB of a file is read", () => {
    const at = Date.now();
    const folder = dayFolder(at);
    const watch = new ReferenceMatch(home, TARGET, at);
    const pad = {
      type: "event_msg",
      payload: { type: "token_count", note: "x".repeat(ROLLOUT_READ_BYTES) },
    };
    const late = `${rollout()}${JSON.stringify(pad)}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: brief(REF) } })}\n`;
    writeFileSync(join(folder, "rollout-late.jsonl"), late);
    expect(watch.look(at)).toBeUndefined();
  });
});
