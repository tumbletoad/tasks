// T3's machine state: the plans file is read back whole, and the
// service's reader takes no file over T3_FILE_MAX_BYTES (hub/t3.ts). A write must never grow it past
// that size, or the next read finds nothing and the next write drops every plan, among them the ones
// a repeat or a folder check still needs. Fixture data only, in memory.
import { describe, expect, test } from "vitest";
import {
  readPlan,
  T3_FILE_MAX_BYTES,
  writePlan,
  type T3Files,
  type T3Plan,
} from "../src/t3-state.ts";

/** Like the service's T3Files: a file over the size limit reads as absent. */
function limitedFiles(): { files: T3Files; text: (name: string) => string } {
  const store = new Map<string, string>();
  return {
    files: {
      read: (name) => {
        const text = store.get(name);
        return text !== undefined && Buffer.byteLength(text) <= T3_FILE_MAX_BYTES
          ? text
          : undefined;
      },
      write: (name, text) => {
        store.set(name, text);
      },
    },
    text: (name) => store.get(name) ?? "",
  };
}

const START = Date.UTC(2026, 10, 14, 9, 0, 0);

/** A plan near the largest one a launch writes: a long title and a long worktree path. */
const plan = (i: number): T3Plan => ({
  projectId: "proj-0001-fixture",
  strategy: { type: "existing_worktree", worktreePath: `/work/${"w".repeat(4000)}` },
  title: `M-14 ${"t".repeat(1000)}`,
  folder: { dev: "2049", ino: String(1000 + i) },
  createdAt: START + i * 1000,
});

describe("[A4.3.16.t3.state] T3's machine state", () => {
  test("the plans file stays within what its reader takes: the oldest plans go first, never all", () => {
    const { files, text } = limitedFiles();
    for (let i = 0; i < 400; i += 1) {
      writePlan(files, `la_fixture${String(i).padStart(4, "0")}`, plan(i), START + i * 1000);
      expect(Buffer.byteLength(text("plans"))).toBeLessThanOrEqual(T3_FILE_MAX_BYTES);
      // The plan just written and the one before it are both there after every write.
      expect(readPlan(files, `la_fixture${String(i).padStart(4, "0")}`)).toEqual(plan(i));
      if (i > 0) {
        expect(readPlan(files, `la_fixture${String(i - 1).padStart(4, "0")}`)).toEqual(plan(i - 1));
      }
    }
    // What is kept is the newest plans, without a gap.
    const kept = Array.from({ length: 400 }, (_, i) =>
      readPlan(files, `la_fixture${String(i).padStart(4, "0")}`) === undefined ? 0 : 1,
    );
    const first = kept.indexOf(1);
    expect(first).toBeGreaterThan(0);
    expect(kept.slice(first).every((k) => k === 1)).toBe(true);
    expect(400 - first).toBeGreaterThan(50);
  });
});
