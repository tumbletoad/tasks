import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { A1_ERRORS } from "@tasks/contracts";
import { describe, expect, test } from "vitest";
import { readOnly, spaceUnavailable } from "../ops/errors.ts";
import { storageFailureBody } from "./space-errors.ts";
import { viewNotKept } from "./space-verbs.ts";

const asksToRetry = (text: string | undefined): boolean => /try again/i.test(text ?? "");

describe("[A3.3.5.error-retry-words] an error's retry flag says what its sentence says", () => {
  test("a storage failure that asks the person to try again is retryable, and only then", () => {
    for (const cause of Object.keys(A1_ERRORS)) {
      const body = storageFailureBody(cause);
      if (asksToRetry(body.message)) expect(body.data?.["retryable"], cause).toBe(true);
      if (body.data?.["retryable"] === false) expect(asksToRetry(body.message), cause).toBe(false);
    }
    expect(storageFailureBody("SPACE_WRITER_TAKEN").data).toMatchObject({ retryable: true });
  });

  test("a space the service does not serve asks for a retry exactly when the flag allows one", () => {
    for (const reason of ["opening", "not_served", "busy"]) {
      for (const retryable of [true, false]) {
        const body = spaceUnavailable(reason, retryable).toBody();
        expect(
          asksToRetry(`${body.message} ${body.hint ?? ""}`),
          `${reason} ${String(retryable)}`,
        ).toBe(retryable);
      }
    }
    for (const body of [readOnly(undefined).toBody(), viewNotKept("closed").toBody()]) {
      expect(asksToRetry(`${body.message} ${body.hint ?? ""}`)).toBe(false);
      expect(body.data).toMatchObject({ retryable: false });
    }
  });

  test("every error the service writes out asks for a retry only with retryable true", () => {
    // Each `new AppError({...})` of the service's own code, read as its source text: one that asks
    // to try again sets retryable true, and one that sets it false never asks.
    const src = join(import.meta.dirname, "..");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const wrong: string[] = [];
    let seen = 0;
    for (const name of files) {
      const text = readFileSync(join(src, name), "utf8");
      for (
        let at = text.indexOf("new AppError(");
        at >= 0;
        at = text.indexOf("new AppError(", at + 1)
      ) {
        let depth = 0;
        let end = at + "new AppError".length;
        for (; end < text.length; end += 1) {
          if (text[end] === "(") depth += 1;
          else if (text[end] === ")" && (depth -= 1) === 0) break;
        }
        const body = text.slice(at, end);
        const flag = /retryable:\s*(true|false)\b/u.exec(body)?.[1];
        // A flag computed at run time is the builder's own test's to check.
        if (flag === undefined && /\bretryable\b/u.test(body)) continue;
        seen += 1;
        if (asksToRetry(body) && flag !== "true") {
          wrong.push(
            `${relative(src, join(src, name))}:${String(text.slice(0, at).split("\n").length)}`,
          );
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(wrong).toEqual([]);
  });
});
