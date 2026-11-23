// The top field's adds against fake tabs: one browser's storage and locks shared by two pages,
// each with its own sends, the service played by the test.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Refused } from "../api.ts";
import type { Kept } from "../kept.ts";
import type { Settled } from "../store/pending.ts";
import { Adds, memoryLocks, SHOW_MS, signInMark, type KeptAdd, type Locks } from "./adds.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const MARK = signInMark("ttasks_u_first");

/** One browser's storage: a tab hears what another tab keeps, as storage events go. */
class Browser {
  readonly values = new Map<string, string>();
  readonly locks: Locks = memoryLocks();
  readonly #tabs = new Set<{ readonly prefix: string; readonly listener: () => void }>();

  tab(): { kept: Kept; heard: (prefix: string, listener: () => void) => () => void } {
    const mine = new Set<{ readonly prefix: string; readonly listener: () => void }>();
    const kept: Kept = {
      read: (name) => this.values.get(name),
      keep: (name, value) => {
        if (value === undefined) this.values.delete(name);
        else this.values.set(name, value);
        for (const other of this.#tabs) {
          if (!mine.has(other) && name.startsWith(other.prefix)) other.listener();
        }
      },
      names: (prefix) => [...this.values.keys()].filter((name) => name.startsWith(prefix)),
      json: (name) => {
        const value = this.values.get(name);
        return value === undefined ? undefined : (JSON.parse(value) as unknown);
      },
    };
    return {
      kept,
      heard: (prefix, listener) => {
        const entry = { prefix, listener };
        this.#tabs.add(entry);
        mine.add(entry);
        return () => {
          this.#tabs.delete(entry);
        };
      },
    };
  }

  /** The adds kept, as stored. */
  adds(): KeptAdd[] {
    return [...this.values.values()].map((value) => JSON.parse(value) as KeptAdd);
  }
}

/** A call the test answers: made, lost on the way back, or refused. */
interface Call {
  readonly add: KeptAdd;
  made(): void;
  lost(error?: unknown): void;
  /** The feed names the request: the add is in the list. */
  fed(): void;
}

/** A page of the space: its sends wait for the test. */
class Page {
  readonly calls: Call[] = [];
  readonly said: string[] = [];
  readonly adds: Adds;

  constructor(
    browser: Browser,
    live: boolean,
    signIn = MARK,
    failed: (error: unknown) => boolean = () => false,
  ) {
    const tab = browser.tab();
    this.adds = new Adds(
      {
        space: SPACE,
        signIn,
        ...tab,
        locks: browser.locks,
        send: (add) => {
          let made!: () => void;
          let lost!: (error: unknown) => void;
          let settle!: (settled: Settled) => void;
          const answer = new Promise<unknown>((resolve, reject) => {
            made = () => {
              resolve({ as_of: "1.11.abcdefgh" });
              settle("confirmed");
            };
            lost = (error) => {
              reject(error instanceof Error ? error : new Error("lost"));
              settle("refused");
            };
          });
          const settled = new Promise<Settled>((resolve) => {
            settle = resolve;
          });
          this.calls.push({
            add,
            made,
            fed: () => {
              settle("confirmed");
            },
            lost: (error = new TypeError("Failed to fetch")) => {
              lost(error);
            },
          });
          return { answer, settled };
        },
        failed,
        added: (add) => {
          this.said.push(`Added to ${add.where}`);
        },
      },
      live,
    );
  }

  lines() {
    return this.adds.lines().map((line) => [line.add.text, line.state, line.said]);
  }
}

const words = (text: string, where = "Inbox") => ({
  text,
  kept: [],
  task: { title: text, inbox: true },
  where,
});

/** Lets the sends and lock hand-overs that are due run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let browser: Browser;

beforeEach(() => {
  vi.useFakeTimers();
  browser = new Browser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("[A5.3.13.web.add-kept] an add from the top field is a thing of its own until the service says what it did", () => {
  test("it is kept before it is sent, and gone once made: a usual add shows no line and says Added once its row is in", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Call the plumber"));
    await settle();
    expect(browser.adds().map((add) => add.text)).toEqual(["Call the plumber"]);
    expect(page.calls).toHaveLength(1);
    page.calls[0]?.made();
    await settle();
    expect(browser.values.size).toBe(0);
    expect(page.said).toEqual(["Added to Inbox"]);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(page.lines()).toEqual([]);
  });

  test("an add still on its way after a moment shows as adding, and one that got no answer as not confirmed, kept exactly as sent", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Fix the p1 report"));
    await settle();
    expect(page.lines()).toEqual([]);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(page.lines()).toEqual([["Fix the p1 report", "adding", undefined]]);
    const before = [...browser.values.values()];
    page.calls[0]?.lost();
    await settle();
    expect(page.lines()).toEqual([["Fix the p1 report", "unanswered", undefined]]);
    expect([...browser.values.values()]).toEqual(before);
    expect(page.said).toEqual([]);
  });

  test("an answer lost after the feed named the add: it was made, and says so", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Book the dentist"));
    await settle();
    page.calls[0]?.fed();
    page.calls[0]?.lost();
    await settle();
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(page.lines()).toEqual([]);
    expect(browser.values.size).toBe(0);
    expect(page.said).toEqual(["Added to Inbox"]);
  });

  test("the page live again sends it by itself under the same request ID and task, and the made task says Added", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Order the hinge pins", "Home"));
    await settle();
    page.calls[0]?.lost();
    page.adds.live(false);
    await settle();
    page.adds.live(true);
    await settle();
    expect(page.calls).toHaveLength(2);
    expect(page.calls[1]?.add.request).toBe(page.calls[0]?.add.request);
    expect(page.calls[1]?.add.task).toEqual(page.calls[0]?.add.task);
    page.calls[1]?.made();
    await settle();
    expect(page.lines()).toEqual([]);
    expect(browser.values.size).toBe(0);
    expect(page.said).toEqual(["Added to Home"]);
  });

  test("a reload brings it back: a live page sends it at once under its request ID, a page that is not live shows it and waits", async () => {
    const first = new Page(browser, true);
    first.adds.add(words("Order the padlock"));
    await settle();
    // The page goes before any answer: its lock goes with it.
    first.adds.stop();
    first.calls[0]?.lost();
    const request = first.calls[0]?.add.request;

    const offline = new Page(browser, false);
    await settle();
    expect(offline.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(offline.lines()).toEqual([["Order the padlock", "unanswered", undefined]]);
    offline.adds.stop();

    const live = new Page(browser, true);
    await settle();
    expect(live.calls.map((call) => call.add.request)).toEqual([request]);
    live.calls[0]?.made();
    await settle();
    // Sent again as the page loads and made at once: only Added says so.
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(live.lines()).toEqual([]);
    expect(live.said).toEqual(["Added to Inbox"]);
  });

  test("Try again sends it under its request ID, also while the feed is down", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Buy milk"));
    await settle();
    page.calls[0]?.lost();
    page.adds.live(false);
    await settle();
    page.adds.tryAgain(page.calls[0]?.add.request ?? "");
    await settle();
    expect(page.lines()).toEqual([["Buy milk", "adding", undefined]]);
    expect(page.calls[1]?.add.request).toBe(page.calls[0]?.add.request);
  });

  test("a refusal the service decided is said with its words, never sent again by itself, and Edit gives the words and the kept shortcuts back", async () => {
    const page = new Page(browser, true);
    page.adds.add({ ...words("Plan #gone"), kept: ["due:0"] });
    await settle();
    page.calls[0]?.lost(new Refused(404, "not_found", "No area gone."));
    await settle();
    expect(page.lines()).toEqual([["Plan #gone", "refused", "No area gone."]]);
    page.adds.live(false);
    page.adds.live(true);
    await settle();
    expect(page.calls).toHaveLength(1);
    const request = page.calls[0]?.add.request ?? "";
    expect(page.adds.edit(request)).toMatchObject({ text: "Plan #gone", kept: ["due:0"] });
    expect(page.lines()).toEqual([]);
    expect(browser.values.size).toBe(0);
  });

  test("an answer that decides nothing (busy, an internal fault, the page signed out) leaves it not confirmed", async () => {
    const signedOut = new Error("signed out");
    const page = new Page(browser, true, MARK, (error) => error === signedOut);
    for (const error of [
      new Refused(503, "service_unavailable"),
      new Refused(500, "internal"),
      new Refused(502, "unknown"),
      signedOut,
    ]) {
      page.adds.add(words(`Task ${error.message}`));
      await settle();
      page.calls.at(-1)?.lost(error);
      await settle();
    }
    expect(page.lines().map((line) => line[1])).toEqual([
      "unanswered",
      "unanswered",
      "unanswered",
      "unanswered",
    ]);
  });

  test("Discard takes the line away at once and keeps nothing; one on its way that is made after all still says Added", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Water the plants"));
    page.adds.add(words("Call Bo"));
    await settle();
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    const [plants, bo] = page.calls;
    page.adds.discard(plants?.add.request ?? "");
    page.adds.discard(bo?.add.request ?? "");
    expect(page.lines()).toEqual([]);
    expect(browser.values.size).toBe(0);
    plants?.made();
    bo?.lost();
    await settle();
    expect(page.lines()).toEqual([]);
    expect(browser.values.size).toBe(0);
    expect(page.said).toEqual(["Added to Inbox"]);
  });

  test("each Enter is its own add: the same words twice are two requests", async () => {
    const page = new Page(browser, true);
    page.adds.add(words("Stretch"));
    page.adds.add(words("Stretch"));
    await settle();
    expect(new Set(page.calls.map((call) => call.add.request)).size).toBe(2);
  });

  test("two tabs never send it at once: the other tab shows it as adding, takes it over once the first lets it go without an answer, and drops it once made", async () => {
    const a = new Page(browser, true);
    a.adds.add(words("Fix the gate latch"));
    await settle();
    const b = new Page(browser, true);
    await settle();
    expect(b.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(b.lines()).toEqual([["Fix the gate latch", "adding", undefined]]);

    a.calls[0]?.lost();
    await settle();
    expect(b.calls.map((call) => call.add.request)).toEqual([a.calls[0]?.add.request]);
    b.calls[0]?.made();
    await settle();
    expect(a.lines()).toEqual([]);
    expect(b.lines()).toEqual([]);
    expect(b.said).toEqual(["Added to Inbox"]);
    expect(a.said).toEqual([]);

    // Both live again at once: one of them sends.
    a.adds.add(words("Oil the hinge"));
    await settle();
    a.calls.at(-1)?.lost();
    await settle();
    b.calls.at(-1)?.lost();
    await settle();
    a.adds.live(false);
    b.adds.live(false);
    const [fromA, fromB] = [a.calls.length, b.calls.length];
    a.adds.live(true);
    b.adds.live(true);
    await settle();
    const sent = [...a.calls.slice(fromA), ...b.calls.slice(fromB)];
    expect(sent).toHaveLength(1);
    sent[0]?.made();
    await settle();
    expect(a.lines()).toEqual([]);
    expect(b.lines()).toEqual([]);
  });

  test("an add discarded in another tab leaves this one too", async () => {
    const a = new Page(browser, true);
    a.adds.add(words("Sort the mail"));
    await settle();
    a.calls[0]?.lost();
    await settle();
    const b = new Page(browser, false);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(b.lines()).toHaveLength(1);
    b.adds.discard(a.calls[0]?.add.request ?? "");
    expect(a.lines()).toEqual([]);
  });

  test("one sent under an earlier sign-in is never sent by itself; Add sends it as a new request of this sign-in", async () => {
    const before = new Page(browser, true, signInMark("ttasks_u_earlier"));
    before.adds.add(words("Renew the passport"));
    await settle();
    before.calls[0]?.lost();
    await settle();
    before.adds.stop();

    const page = new Page(browser, true);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(page.calls).toHaveLength(0);
    expect(page.lines()).toEqual([["Renew the passport", "signedInAgain", undefined]]);
    page.adds.addAgain(before.calls[0]?.add.request ?? "");
    await settle();
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.add.request).not.toBe(before.calls[0]?.add.request);
    expect(page.calls[0]?.add.task).toEqual(before.calls[0]?.add.task);
    expect(browser.adds().map((add) => add.request)).toEqual([page.calls[0]?.add.request]);
  });

  test("whatever a capture can make reads back: long words and a long area label; one this build cannot read is left alone", async () => {
    const page = new Page(browser, true);
    page.adds.add({
      text: "x".repeat(500),
      kept: [],
      task: { title: "x".repeat(480), inbox: false, area: "a_1", project: "pj_1", focus: true },
      where: `${"Area ".repeat(40)}/ ${"Project ".repeat(30)}`,
    });
    await settle();
    page.calls[0]?.lost();
    await settle();
    page.adds.stop();
    browser.values.set(`add.${SPACE}.junk`, JSON.stringify({ text: "from another build" }));
    const again = new Page(browser, false);
    await vi.advanceTimersByTimeAsync(SHOW_MS);
    expect(again.lines()).toHaveLength(1);
    expect(browser.values.get(`add.${SPACE}.junk`)).toBeDefined();
  });
});
