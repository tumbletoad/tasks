// The words a person typed for an agent, held for one launch in that launch's own folder
// (requests.ts): only there, private, read back after a restart, and gone with the request.
// Temporary folders and fixture words only.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LaunchRequests, REQUEST_FILE, REQUEST_MAX } from "../src/requests.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const LAUNCH = "la_0c4g8k2n6r0v4y8b2e6h0m4q8t";
const OTHER = "la_0c4g8k2n6r0v4y8b2e6h0m4q8v";
const WORDS = 'Look at "this" first.\nThen: Café, 日本語 and a\ttab.';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const made = mkdtempSync(join(tmpdir(), "tasks-requests-"));
  roots.push(made);
  return join(made, "launch");
}

describe("[A4.5.routes.request-store] a launch's request is held in its own folder, privately, until it goes", () => {
  test("held once per launch, read back exactly, marked read, and still there after a restart", () => {
    const at = root();
    const store = new LaunchRequests(at);
    expect(store.put({ space: SPACE, launch: LAUNCH, route: "terminal", at: 1 }, WORDS)).toBe(true);
    // One click is one request: a second never replaces it.
    expect(store.put({ space: SPACE, launch: LAUNCH, route: "terminal", at: 2 }, "other")).toBe(
      false,
    );
    expect(readdirSync(at)).toEqual([LAUNCH]);
    expect(readdirSync(join(at, LAUNCH))).toEqual([REQUEST_FILE]);
    if (process.platform !== "win32") {
      expect(statSync(at).mode & 0o777).toBe(0o700);
      expect(statSync(join(at, LAUNCH)).mode & 0o777).toBe(0o700);
      expect(statSync(join(at, LAUNCH, REQUEST_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(store.text(SPACE, LAUNCH)).toBe(WORDS);
    // Only for its own space.
    expect(store.text("sp_3q7k9d2xw8f4r6t1c5v0b2n8a8", LAUNCH)).toBeUndefined();
    expect(store.state(LAUNCH)).toBe("waiting");
    expect(store.markRead(LAUNCH)).toBe(true);
    expect(store.markRead(LAUNCH)).toBe(false);
    expect(store.state(LAUNCH)).toBe("read");

    const again = new LaunchRequests(at);
    expect(again.list()).toEqual([
      { space: SPACE, launch: LAUNCH, route: "terminal", at: 1, read: true },
    ]);
    expect(again.text(SPACE, LAUNCH)).toBe(WORDS);
  });

  test("removed with its folder when nothing else is in it; a launch's own files stay; a read one is still known as read", () => {
    const at = root();
    const store = new LaunchRequests(at);
    store.put({ space: SPACE, launch: LAUNCH, route: "link", at: 1 }, WORDS);
    store.markRead(LAUNCH);
    store.remove(LAUNCH);
    expect(readdirSync(at)).toEqual([]);
    expect(store.state(LAUNCH)).toBe("read");
    expect(store.text(SPACE, LAUNCH)).toBeUndefined();

    store.put({ space: SPACE, launch: OTHER, route: "terminal", at: 1 }, WORDS);
    writeFileSync(join(at, OTHER, "launch.json"), "{}");
    store.remove(OTHER);
    expect(readdirSync(join(at, OTHER))).toEqual(["launch.json"]);
    expect(store.state(OTHER)).toBeUndefined();
  });

  test("a launch folder removed under it takes the request with it", () => {
    const at = root();
    const store = new LaunchRequests(at);
    store.put({ space: SPACE, launch: LAUNCH, route: "terminal", at: 1 }, WORDS);
    rmSync(join(at, LAUNCH), { recursive: true, force: true });
    expect(store.state(LAUNCH)).toBeUndefined();
    expect(store.text(SPACE, LAUNCH)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test("a file that is not a request is removed at the next start; other folders and files are left alone", () => {
    const at = root();
    mkdirSync(join(at, LAUNCH), { recursive: true });
    writeFileSync(join(at, LAUNCH, REQUEST_FILE), "not json");
    mkdirSync(join(at, "not-a-launch"));
    writeFileSync(join(at, "not-a-launch", REQUEST_FILE), "kept");
    const store = new LaunchRequests(at);
    expect(store.list()).toEqual([]);
    expect(readdirSync(at).sort()).toEqual(["not-a-launch"]);
    // Words of no length, or past the composer's limit, are not a request.
    expect(() =>
      store.put(
        { space: SPACE, launch: LAUNCH, route: "link", at: 1 },
        "x".repeat(REQUEST_MAX + 1),
      ),
    ).toThrow();
    expect(() => store.put({ space: SPACE, launch: LAUNCH, route: "link", at: 1 }, "")).toThrow();
  });
});
