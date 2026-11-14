// The query language (A3 3.9.2) and A3 5's parser property: "Random strings never produce an
// SQLite or FTS5 syntax error. The result is always rows or invalid_input. Parsing, printing
// parsed: and parsing again gives the same query." This file holds the parsing half; the space
// half (rows or invalid_input against a real index) is packages/service/test/search.test.ts.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { AppError } from "@tasks/contracts";
import { queryText } from "../../test/search-queries.ts";
import { namesLifecycle, parseQuery, printQuery, type Query } from "./query.ts";

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[A3.5.search.parser] the query language", () => {
  test("A3 3.9.2's examples parse into words, phrases, OR groups and filters", () => {
    const q = parseQuery(
      'timezone "time zone" OR dst status:open,waiting area:client-work p<=2 due<7d',
    );
    expect(q.groups.map((g) => g.map((t) => (t.type === "text" ? t.text : t.key)))).toEqual([
      ["timezone"],
      ["time zone", "dst"],
      ["status"],
      ["area"],
      ["p"],
      ["due"],
    ]);
    expect(q.groups[1]?.[0]).toMatchObject({ type: "text", phrase: true, negated: false });
    expect(q.groups[4]?.[0]).toMatchObject({ type: "filter", key: "p", op: "<=", value: "2" });
    const second = parseQuery(
      "-status:waiting is:overdue has:learnings source:jira:LUM-212 by:agent updated>-24h " +
        "completed>2026-10-01 on:cwd id:M-14",
    );
    expect(second.groups.flat()).toHaveLength(9);
    expect(second.groups[0]?.[0]).toMatchObject({ key: "status", negated: true });
    expect(second.groups[3]?.[0]).toMatchObject({ key: "source", value: "jira:LUM-212" });
    expect(printQuery(second)).toBe(
      "-status:waiting is:overdue has:learnings source:jira:LUM-212 by:agent updated>-24h " +
        "completed>2026-10-01 on:cwd id:M-14",
    );
  });

  test("quotes make phrases, a doubled quote is one quote, and a key is letters only", () => {
    const q = parseQuery('"a ""b"" c" 10:30 area:"Client work" Status:open');
    expect(q.groups.flat()).toEqual([
      { type: "text", text: 'a "b" c', phrase: true, negated: false },
      { type: "text", text: "10:30", phrase: false, negated: false },
      { type: "filter", key: "area", op: ":", value: "Client work", negated: false },
      { type: "filter", key: "status", op: ":", value: "open", negated: false },
    ]);
    expect(printQuery(q)).toBe('"a ""b"" c" 10:30 area:"Client work" status:open');
    expect(parseQuery('"unterminated phrase').groups[0]?.[0]).toMatchObject({
      text: "unterminated phrase",
      phrase: true,
    });
    expect(parseQuery("").groups).toEqual([]);
  });

  test("an unknown key fails with a suggestion and never quotes the query", () => {
    const error = refusal(() => parseQuery("prio:1 secret-word"));
    expect(error.code).toBe("invalid_input");
    expect(error.hint).toBe("Did you mean p?");
    expect(error.data["suggestions"]).toEqual(["p"]);
    expect(JSON.stringify(error.toBody())).not.toMatch(/prio|secret-word/);
    expect(refusal(() => parseQuery("stauts:open")).hint).toBe("Did you mean status?");
    expect(refusal(() => parseQuery("is:inbx")).hint).toBe("Did you mean inbox?");
  });

  test("OR, negation, limits and values are checked", () => {
    for (const bad of [
      "OR zone",
      "zone OR",
      "zone OR OR clinic",
      "-zone OR clinic",
      "zone OR status:open",
      "status:",
      'status:""',
      "status<open",
      "p:5",
      "due:someday",
      "due<none",
      "created>yesterday",
      "by:robot",
      "id:fourteen",
      "has:everything",
      Array.from({ length: 21 }, (_, i) => `w${String(i)}`).join(" "),
      "x".repeat(501),
    ]) {
      expect(refusal(() => parseQuery(bad)).code, bad).toBe("invalid_input");
    }
    expect(Array.from({ length: 20 }, (_, i) => `w${String(i)}`).join(" ")).toSatisfy(
      (text: string) => parseQuery(text).groups.length === 20,
    );
  });

  test("is:new and is:changed are refused naming the step that brings their data", () => {
    for (const later of ["is:new", "is:changed"]) {
      const error = refusal(() => parseQuery(later));
      expect(error.code).toBe("invalid_input");
      expect(error.hint).toMatch(/M5\.09/);
    }
  });

  test("a query that names completed or archived tasks widens the default scope", () => {
    expect(namesLifecycle(parseQuery("is:completed"))).toBe(true);
    expect(namesLifecycle(parseQuery("completed>2026-01-01"))).toBe(true);
    expect(namesLifecycle(parseQuery("-is:archived zone"))).toBe(false);
    expect(namesLifecycle(parseQuery("is:inbox"))).toBe(false);
  });

  test("random strings parse or are refused as invalid_input, and parsed reads back the same", () => {
    fc.assert(
      fc.property(queryText, (text) => {
        let query: Query;
        try {
          query = parseQuery(text);
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe("invalid_input");
          return;
        }
        const printed = printQuery(query);
        expect(parseQuery(printed)).toEqual(query);
        expect(printQuery(parseQuery(printed))).toBe(printed);
      }),
      { numRuns: 3000 },
    );
  });
});
