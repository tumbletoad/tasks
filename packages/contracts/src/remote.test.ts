// The remote command envelope (A6 3.3 "Remote envelope types", 3.8.1): types in the registry's type
// package, exposed by no transport until linked machines arrive (L1).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, test } from "vitest";
import { registry } from "./registry.ts";
import {
  REMOTE_MAX_VALIDITY_S,
  REMOTE_VALIDITY_S,
  type RemoteEnvelope,
  type RemoteRequest,
} from "./remote.ts";

const generated = new URL("../generated/", import.meta.url);

describe("[A6.3.3.remote-envelope] the remote envelope types are the registry's and no transport's", () => {
  test("no entry and no generated face names the envelope", () => {
    expect(registry.filter((e) => e.name.startsWith("remote."))).toEqual([]);
    for (const file of readdirSync(generated)) {
      const text = readFileSync(new URL(file, generated), "utf8");
      for (const word of ["remote.execute", "origin_sig", "authority_sig", "command_id"]) {
        expect(text.includes(word), `${file} names ${word}`).toBe(false);
      }
    }
  });

  test("every action expires within the longest validity a receiver accepts", () => {
    for (const seconds of Object.values(REMOTE_VALIDITY_S)) {
      expect(seconds).toBeLessThanOrEqual(REMOTE_MAX_VALIDITY_S);
    }
    // R10: the request carries no executable, argv, environment or absolute path.
    expectTypeOf<
      Extract<keyof RemoteRequest, "argv" | "env" | "path" | "executable" | "folder">
    >().toEqualTypeOf<never>();
    expectTypeOf<RemoteEnvelope["type"]>().toEqualTypeOf<"remote.execute">();
  });
});
