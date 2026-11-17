import { A1_ERRORS } from "@tasks/contracts";
import { describe, expect, test } from "vitest";
import { spaceUnavailable } from "../ops/errors.ts";
import { storageFailureBody } from "./space-errors.ts";

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
        expect(asksToRetry(`${body.message} ${body.hint ?? ""}`), `${reason} ${retryable}`).toBe(
          retryable,
        );
      }
    }
  });
});
