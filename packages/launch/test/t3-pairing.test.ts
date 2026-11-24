// Pairing with T3 (A4 3.4.1 "Pairing", A7 3.9 M2.11): OAuth with PKCE against a fake T3 server on
// a loopback port the OS assigns. S256 only, a fresh verifier and state per attempt, the redirect on
// loopback, the state compared before the code is exchanged, a deadline on every wait, secrets sent
// to loopback endpoints only, and no secret in an error. Fixture data and a temporary folder only.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { currentPerson } from "@ttasks/files/person";
import { FakeT3 } from "@ttasks/testkit/fake-t3";
import { readT3Origin, T3Error, T3Mcp } from "../src/t3-client.ts";
import { beginPairing, PairingError, type PairingAttempt } from "../src/t3-oauth.ts";

const SLOW = 60_000;
let base: string;
let fake: FakeT3;
const attempts: PairingAttempt[] = [];

beforeEach(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-t3-pair-")));
  fake = await FakeT3.start(join(base, "t3home"));
});

afterEach(async () => {
  for (const attempt of attempts.splice(0)) attempt.cancel();
  await fake.stop();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function begin(options: Partial<Parameters<typeof beginPairing>[0]> = {}) {
  const attempt = await beginPairing({ origin: fake.origin, requestMs: 15_000, ...options });
  attempts.push(attempt);
  return attempt;
}

/** A fetch that rewrites the authorization server's metadata, to play another server. */
function metadataAs(change: (meta: Record<string, unknown>) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/.well-known/oauth-authorization-server")) return response;
    const meta = (await response.json()) as Record<string, unknown>;
    change(meta);
    return new Response(JSON.stringify(meta), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("[A4.3.4.1.t3.pairing] pairing with T3 by OAuth and PKCE", () => {
  test(
    "S256, a fresh challenge and state per attempt, a loopback redirect on a port of its own",
    async () => {
      const one = new URL((await begin()).url);
      const two = new URL((await begin()).url);
      for (const url of [one, two]) {
        expect(url.origin).toBe(fake.origin);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(url.searchParams.get("redirect_uri")).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/callback$/u,
        );
        expect(url.searchParams.get("resource")).toBe(`${fake.origin}/mcp`);
      }
      expect(one.searchParams.get("state")).not.toBe(two.searchParams.get("state"));
      expect(one.searchParams.get("code_challenge")).not.toBe(
        two.searchParams.get("code_challenge"),
      );
      expect(one.searchParams.get("redirect_uri")).not.toBe(two.searchParams.get("redirect_uri"));
      // Each attempt registered its own redirect.
      expect(fake.registrations).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "a callback with another state, or none, is refused before any exchange; the right one pairs",
    async () => {
      const attempt = await begin();
      const url = new URL(attempt.url);
      const callback = url.searchParams.get("redirect_uri") ?? "";
      for (const query of ["?state=wrong&code=fixture-code", "?code=fixture-code", ""]) {
        const page = await fetch(`${callback}${query}`);
        expect(page.status).toBe(400);
        expect(await page.text()).not.toContain("fixture-code");
      }
      expect((await fetch(callback.replace("/callback", "/other"))).status).toBe(404);
      expect(fake.tokenRequests).toBe(0);
      expect(await fake.approveInBrowser(attempt.url)).toBe(200);
      const grant = await attempt.wait();
      expect(grant.accessToken).toMatch(/^fake-at-/u);
      expect(grant.expiresAt).toBeTypeOf("number");
      expect(fake.tokenRequests).toBe(1);
      // The attempt is over: a second callback with the same state changes nothing.
      const again = await fetch(
        `${callback}?state=${url.searchParams.get("state") ?? ""}&code=x`,
      ).catch(() => undefined);
      expect(again === undefined || again.status !== 200).toBe(true);
      expect(fake.tokenRequests).toBe(1);
    },
    SLOW,
  );

  test(
    "a request target that is no URL is answered 400; the attempt keeps waiting and still pairs",
    async () => {
      const attempt = await begin();
      const callback = new URL(new URL(attempt.url).searchParams.get("redirect_uri") ?? "");
      // A raw request whose target `new URL` cannot parse. Before the fix it threw in the
      // listener's handler: an uncaught exception that ends the process hosting the pairing.
      for (const target of ["//[", "//%", "http://[::1"]) {
        const answer = await new Promise<string>((resolve, reject) => {
          const socket = connect(Number(callback.port), "127.0.0.1");
          let text = "";
          socket.setEncoding("latin1");
          socket.on("data", (chunk: string) => (text += chunk));
          socket.on("end", () => {
            resolve(text);
          });
          socket.on("close", () => {
            resolve(text);
          });
          socket.on("error", reject);
          socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        expect(answer.split("\r\n")[0], target).toMatch(/^HTTP\/1\.1 4\d\d /u);
      }
      expect(fake.tokenRequests).toBe(0);
      expect(await fake.approveInBrowser(attempt.url)).toBe(200);
      expect((await attempt.wait()).accessToken).toMatch(/^fake-at-/u);
    },
    SLOW,
  );

  test(
    "a refusal on T3's page, and an approval that never comes, end the attempt",
    async () => {
      fake.approval = "deny";
      const denied = await begin();
      expect(await fake.approveInBrowser(denied.url)).toBe(400);
      await expect(denied.wait()).rejects.toMatchObject({ name: "PairingError", reason: "denied" });
      expect(fake.tokenRequests).toBe(0);

      const late = await begin({ deadlineMs: 200 });
      await expect(late.wait()).rejects.toMatchObject({ reason: "timed_out" });
      // The listener is closed: the callback no longer answers.
      const callback = new URL(late.url).searchParams.get("redirect_uri") ?? "";
      await expect(fetch(callback)).rejects.toThrow();

      const cancelled = await begin();
      cancelled.cancel();
      await expect(cancelled.wait()).rejects.toBeInstanceOf(PairingError);
    },
    SLOW,
  );

  test(
    "a server without S256, or with an endpoint off loopback, is refused before anything is sent",
    async () => {
      await expect(
        begin({ fetch: metadataAs((m) => (m["code_challenge_methods_supported"] = ["plain"])) }),
      ).rejects.toMatchObject({ reason: "unsupported" });
      await expect(
        begin({ fetch: metadataAs((m) => delete m["code_challenge_methods_supported"]) }),
      ).rejects.toMatchObject({ reason: "unsupported" });
      await expect(
        begin({
          fetch: metadataAs((m) => (m["token_endpoint"] = "https://t3.example.invalid/token")),
        }),
      ).rejects.toMatchObject({ reason: "unsupported" });
      expect(fake.registrations).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "T3's origin is read from its runtime file, loopback only; a token never appears in an error",
    async () => {
      expect(await readT3Origin(fake.home)).toEqual({ status: "ok", origin: fake.origin });
      const other = join(base, "other-home");
      // User-only whatever the umask (002 on an Ubuntu desktop), as TTasks needs T3's files.
      mkdirSync(join(other, "userdata"), { recursive: true, mode: 0o700 });
      const runtime = join(other, "userdata", "server-runtime.json");
      for (const origin of ["http://t3.example.invalid:4000", "file:///x", 42]) {
        writeFileSync(runtime, JSON.stringify({ origin }), { mode: 0o600 });
        expect(await readT3Origin(other)).toEqual({ status: "not_running" });
      }
      expect(await readT3Origin(join(base, "nowhere"))).toEqual({ status: "not_running" });
      // A file a killed T3 left behind: its process is gone, so T3 does not run.
      writeFileSync(runtime, JSON.stringify({ origin: fake.origin, pid: 2_147_483_646 }), {
        mode: 0o600,
      });
      expect(await readT3Origin(other)).toEqual({ status: "not_running" });
      if (process.platform !== "win32") {
        writeFileSync(runtime, JSON.stringify({ origin: fake.origin }));
        chmodSync(runtime, 0o666);
        expect(await readT3Origin(other)).toEqual({ status: "unsafe" });
        // As T3 makes them under umask 002 (0775, 0664): its group may write them only when that
        // group is the person's own private group, as for TTasks's own files (A2 3.2.2 rule 5).
        const userdata = join(other, "userdata");
        chmodSync(runtime, 0o664);
        chmodSync(userdata, 0o775);
        const own = currentPerson()?.ownGroup();
        const ours =
          own !== undefined && statSync(runtime).gid === own && statSync(userdata).gid === own;
        expect(await readT3Origin(other)).toEqual(
          ours ? { status: "ok", origin: fake.origin } : { status: "unsafe" },
        );
        chmodSync(userdata, 0o700);
        // A link at the file is never followed, even to a file that would pass (O_NOFOLLOW).
        chmodSync(runtime, 0o600);
        rmSync(runtime);
        symlinkSync(fake.runtimeFile, runtime);
        expect(await readT3Origin(other)).toEqual({ status: "unsafe" });
      }

      const mcp = new T3Mcp({ requestMs: 15_000 });
      const token = "fake-at-not-issued-0001";
      const error = await mcp
        .call({ origin: fake.origin, token }, "t3_project_list", {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(T3Error);
      expect((error as T3Error).failure).toBe("unauthorized");
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
      // Never to another host, whatever the caller passes.
      await expect(
        mcp.call({ origin: "http://t3.example.invalid", token }, "t3_project_list", {}),
      ).rejects.toMatchObject({ failure: "rejected" });
    },
    SLOW,
  );
});
