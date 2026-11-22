// The top field's add whose answer the page did not hear (adds.ts): kept apart from what the field
// holds, with the request as it was sent, and let go only on the service's word.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Kept } from "../kept.ts";
import type { Receipt } from "../edit/calls.ts";
import { keepSent, readSent, wordOn, type SentAdd } from "./adds.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const ID = "0f8c7a52-3c1e-4d7b-9a6e-2b4f1d0c9e88";

/** A tab's storage in memory. */
function memory(): Kept {
  const values = new Map<string, string>();
  return {
    read: (name) => values.get(name),
    keep: (name, value) => {
      if (value === undefined) values.delete(name);
      else values.set(name, value);
    },
    names: (prefix) => [...values.keys()].filter((name) => name.startsWith(prefix)),
    json: (name) => {
      const value = values.get(name);
      if (value === undefined) return undefined;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

const sent: SentAdd = {
  request: ID,
  text: "Buy milk tomorrow",
  task: { title: "Buy milk", due: "2026-11-23" },
  where: "Inbox",
};

const found = (status: string): Receipt =>
  ({
    found: true,
    request: ID,
    status,
    decided_at: "2026-11-22T10:00:00.000Z",
    as_of: "1.12.01234567",
    incarnation: "ai_0123456789abcdefghjkmnpq",
    commit: "op_00000000000000000000000012",
    results: [],
    warnings: [],
  }) as unknown as Receipt;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[A5.3.4.web.add-once] an add whose answer was lost keeps its request until the service says what it did", () => {
  test("it is kept with the request as sent, apart from the field's text, and read back by its shape", () => {
    const kept = memory();
    keepSent(kept, SPACE, sent);
    expect(readSent(kept, SPACE)).toEqual(sent);
    // What the field holds since changes nothing of it.
    kept.keep(`top.${SPACE}`, JSON.stringify({ text: "Buy milk tomorrow!", kept: [] }));
    expect(readSent(kept, SPACE)).toEqual(sent);
    keepSent(kept, SPACE, undefined);
    expect(readSent(kept, SPACE)).toBeUndefined();
    for (const bad of [
      { ...sent, request: "not-an-id" },
      { ...sent, text: "" },
      { ...sent, task: "Buy milk" },
      { ...sent, task: { due: "2026-11-23" } },
      "Buy milk",
    ]) {
      kept.keep(`added.${SPACE}`, JSON.stringify(bad));
      expect(readSent(kept, SPACE)).toBeUndefined();
    }
  });

  test("the service's word: made, refused, not heard of, or none in time; a read that fails is none", async () => {
    expect(await wordOn(() => Promise.resolve(found("applied")), ID)).toEqual({
      made: true,
      as_of: "1.12.01234567",
    });
    expect(await wordOn(() => Promise.resolve(found("rejected")), ID)).toBe("refused");
    expect(await wordOn(() => Promise.resolve({ found: false } as unknown as Receipt), ID)).toBe(
      "unheard",
    );
    expect(await wordOn(() => Promise.reject(new TypeError("Failed to fetch")), ID)).toBe(
      "unknown",
    );
    const stalled = wordOn(() => new Promise<Receipt>(() => undefined), ID);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stalled).toBe("unknown");
  });
});
