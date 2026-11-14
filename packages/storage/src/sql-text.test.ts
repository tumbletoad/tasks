import { describe, expect, test } from "vitest";
import { StorageError } from "./errors.ts";
import { isTrivia, namedParameters, placeholders } from "./sql-text.ts";

const tokens = (sql: string): string[] => placeholders(sql).map((p) => p.token);

function refused(sql: string): void {
  try {
    namedParameters(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("STORAGE_MISUSE");
    return;
  }
  throw new Error("expected STORAGE_MISUSE, but nothing was thrown");
}

describe("[A1.5.driver.contract] reading placeholders the way SQLite's tokenizer does", () => {
  test("finds every variable token, with its offsets", () => {
    const sql = "SELECT $a, :b, @c, #d, ?, ?12, $a FROM t";
    expect(tokens(sql)).toEqual(["$a", ":b", "@c", "#d", "?", "?12", "$a"]);
    for (const p of placeholders(sql)) expect(sql.slice(p.start, p.end)).toBe(p.token);
    // Tcl-style forms are one token each. One whose index breaks at a space is a syntax error.
    expect(tokens("SELECT $a::b, $c(d e), $f(g)")).toEqual(["$a::b", "$f(g)"]);
  });

  test("skips strings, quoted names, comments and names that contain $", () => {
    expect(tokens("SELECT 'it''s $a', \"$b\"\"\", `:c`, [@d ?] FROM t")).toEqual([]);
    expect(tokens("SELECT 1 -- $a\n, 2 /* :b ? */ , x$y, _$z, é$w")).toEqual([]);
    expect(tokens("SELECT 1 /* :a")).toEqual([]); // an open comment runs to the end
    expect(tokens("SELECT 'open $a")).toEqual([]); // so does an open string
    expect(tokens("SELECT x'00ff', X'ab' || $a")).toEqual(["$a"]);
    // After a comment, a string or a byte-order mark, a placeholder starts a new token.
    expect(tokens("SELECT/**/$a,'x'$b,﻿$c,--\n$d")).toEqual(["$a", "$b", "$c", "$d"]);
  });

  test("reads numbers like SQLite: a digit run that runs into $ holds no placeholder", () => {
    expect(tokens("SELECT 1$a, 1.5e3$b, 0x1F$c")).toEqual([]);
    expect(tokens("SELECT 1.5e+$a")).toEqual(["$a"]);
    // A lone prefix is not a variable, and SQLite refuses it as a syntax error.
    expect(tokens("SELECT $ , : , @")).toEqual([]);
  });

  test("names each bound parameter once, by its bare name", () => {
    const { names, placeholders: found } = namedParameters("SELECT $a, :b, @c, $a");
    expect(names).toEqual(["a", "b", "c"]);
    expect(found.map((p) => p.name)).toEqual(["a", "b", "c", "a"]);
  });

  test("refuses placeholders that cannot be bound by a plain key", () => {
    for (const sql of [
      "SELECT ?",
      "SELECT ?3",
      "SELECT #a",
      "SELECT $a::b",
      "SELECT $a(b)",
      "SELECT $é",
      "SELECT $a, :a",
    ]) {
      refused(sql);
    }
  });

  test("tells trailing comments and semicolons from a second statement", () => {
    for (const tail of ["", ";", " ;; ", " -- done\n", "/* x */", "﻿\t\r\n\f"]) {
      expect(isTrivia(tail)).toBe(true);
    }
    for (const tail of [" SELECT 2", "x", " 'a'", " $a", "\v"]) {
      expect(isTrivia(tail)).toBe(false);
    }
  });
});
