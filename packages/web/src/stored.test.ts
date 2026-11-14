import { describe, expect, test } from "vitest";
import { keepToken, readToken, TOKEN_KEY, type TokenStore } from "./stored.ts";

const TOKEN = `tasks_u_${"A".repeat(40)}b-_`;

/** A store holding whatever another page could have written. */
function storeWith(value: unknown): TokenStore & { removed: number; set: string[] } {
  let held = value;
  const store = {
    removed: 0,
    set: [] as string[],
    getItem: (key: string) => (key === TOKEN_KEY ? (held as string | null) : null),
    setItem: (key: string, v: string) => {
      if (key === TOKEN_KEY) {
        held = v;
        store.set.push(v);
      }
    },
    removeItem: (key: string) => {
      if (key === TOKEN_KEY) {
        held = null;
        store.removed += 1;
      }
    },
  };
  return store;
}

const throwing: TokenStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("[A5.3.26.web.stored-token] values read back from localStorage are untrusted", () => {
  test("a stored token of the token's exact shape is used", () => {
    expect(readToken(storeWith(TOKEN))).toBe(TOKEN);
  });

  test.each([
    ["markup", `${TOKEN}<img src=x onerror=alert(1)>`],
    ["JSON", JSON.stringify({ token: TOKEN })],
    ["a longer token", `${TOKEN}A`],
    ["a shorter token", TOKEN.slice(0, -1)],
    ["another prefix", TOKEN.replace("tasks_u_", "tasks_a_")],
    ["a newline", `${TOKEN.slice(0, -1)}\n`],
    ["a non-string", 42],
    ["an empty string", ""],
    ["a megabyte", "k".repeat(1 << 20)],
  ])("%s is dropped, removed and read as signed out", (_name, value) => {
    const store = storeWith(value);
    expect(readToken(store)).toBeNull();
    expect(store.removed).toBe(1);
    expect(readToken(store)).toBeNull();
  });

  test("missing, blocked or throwing storage reads as signed out and never throws", () => {
    expect(readToken(undefined)).toBeNull();
    expect(readToken(throwing)).toBeNull();
    expect(() => {
      keepToken(throwing, TOKEN);
    }).not.toThrow();
    expect(() => {
      keepToken(undefined, TOKEN);
    }).not.toThrow();
  });

  test("only a value of the token's shape is ever written; anything else clears the key", () => {
    const store = storeWith(null);
    keepToken(store, "not-a-token");
    expect(store.set).toEqual([]);
    expect(store.removed).toBe(1);
    keepToken(store, TOKEN);
    expect(store.set).toEqual([TOKEN]);
    keepToken(store, null);
    expect(readToken(store)).toBeNull();
  });
});
