// Doctor's accounts and HTTP rows (A2 3.13; A6 3.3; R18): other interactive user
// accounts warn, an agent app's sandbox accounts are not counted, and the UI listener's state and
// self-test are reported: blocked by another user (fail, with A2's message), moved (warn), and a
// rebinding Host and the style nonce checked on the live listener. The machine's accounts are
// injected facts; no account is made or named.
import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { blockedMessage, movedMessage } from "@tasks/service/http/shared";
import { httpWorld, persistPort, type HttpWorld } from "@tasks/service/test/http-world";
import {
  countAccounts,
  linuxAccounts,
  macAccounts,
  uidRange,
  windowsAccounts,
} from "../src/accounts.ts";
import { accountsCheck, excludedRanges, httpCheck, selfTest } from "../src/doctor-http.ts";
import { runMain } from "./cli-harness.ts";

const SLOW = { timeout: 180_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

interface Report {
  ok: boolean;
  checks: { id: string; status: string; detail: string }[];
}

const row = (report: Report, id: string) => report.checks.find((c) => c.id === id);
const ALONE = () => ({ me: "1000", accounts: ["1000"], sandbox: [] });

describe("[A2.3.13.cli.doctor-http] doctor's accounts and HTTP rows", () => {
  test("other accounts are counted per OS; an agent app's sandbox accounts are not", () => {
    // Windows: ProfileList SIDs, this user's left out, CodexSandboxUsers members not counted.
    const win = windowsAccounts(
      JSON.stringify({
        me: "S-1-5-21-1-2-3-1001",
        profiles: ["S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1005"],
        sandbox: ["S-1-5-21-1-2-3-1005", "S-1-5-21-1-2-3-1006"],
      }),
    );
    expect(win).toBeDefined();
    expect(countAccounts(win ?? ALONE())).toEqual({ others: 0, sandbox: 1 });
    expect(accountsCheck(win)).toEqual({
      id: "accounts",
      status: "ok",
      detail: "No other user accounts. 1 agent sandbox account is not counted.",
    });
    // One profile path is a single string in PowerShell's JSON; the second person counts.
    const two = windowsAccounts(
      JSON.stringify({ me: "S-1-5-21-1-2-3-1001", profiles: "S-1-5-21-1-2-3-1009", sandbox: [] }),
    );
    expect(countAccounts(two ?? ALONE())).toEqual({ others: 1, sandbox: 0 });
    expect(windowsAccounts("not json")).toBeUndefined();
    // Linux: the regular UID range of login.defs, a real login shell.
    const passwd = [
      "root:x:0:0:root:/root:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "mira:x:1000:1000:Mira:/home/mira:/bin/bash",
      "jonas:x:1001:1001:Jonas:/home/jonas:/usr/bin/zsh",
      "svc:x:1002:1002::/var/lib/svc:/usr/sbin/nologin",
      "off:x:1003:1003::/home/off:/bin/false",
      "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
      "",
    ].join("\n");
    const range = uidRange("# comment\nUID_MIN\t\t 1000\nUID_MAX\t\t60000\n");
    expect(range).toEqual({ min: 1000, max: 60000 });
    expect(linuxAccounts(passwd, range)).toEqual(["1000", "1001"]);
    expect(
      countAccounts({ me: "1000", accounts: linuxAccounts(passwd, range), sandbox: [] }),
    ).toEqual({ others: 1, sandbox: 0 });
    expect(uidRange("")).toEqual({ min: 1000, max: 60000 });
    // macOS: 501 and up, without the underscore service accounts.
    expect(macAccounts("_www 70\nroot 0\nmira 501\njonas 502\n_spotlight 89\n")).toEqual([
      "501",
      "502",
    ]);
    const warn = accountsCheck({ me: "501", accounts: ["501", "502", "503"], sandbox: [] });
    expect(warn.status).toBe("warn");
    expect(warn.detail).toBe(
      "This machine has 2 other user accounts. TT Tasks v1 assumes one user per machine. Another account could serve a fake TT Tasks page at the UI's address while TT Tasks is stopped.",
    );
    expect(accountsCheck(undefined).status).toBe("skip");
  });

  test(
    "the http row: the live listener's self-test passes; a blocked UI fails with A2's message",
    SLOW,
    async () => {
      const w = await httpWorld("dh");
      worlds.push(w);
      const ran = await runMain(["doctor", "--self-test", "--json"], {
        home: w.home,
        main: { accounts: ALONE },
      });
      const report = JSON.parse(ran.stdout) as Report;
      expect(row(report, "http")).toEqual({
        id: "http",
        status: "ok",
        detail: `Listening on 127.0.0.1:${String(w.port())}; Host and CSP self-test passed.`,
      });
      expect(row(report, "accounts")?.status).toBe("ok");
      expect(report.ok).toBe(true);
      const port = w.port();
      persistPort(w.home, port);
      await w.restart({ holders: (p) => (p === port ? [{ owner: "1002" }] : []) });
      const blocked = JSON.parse(
        (await runMain(["doctor", "--json"], { home: w.home, main: { accounts: ALONE } })).stdout,
      ) as Report;
      expect(row(blocked, "http")).toEqual({
        id: "http",
        status: "fail",
        detail: blockedMessage(port),
      });
      expect(blocked.ok).toBe(false);
    },
  );

  test(
    "a moved port warns with A2's line; a listener without the policy fails its self-test",
    SLOW,
    async () => {
      expect(
        await httpCheck({ port: null, persisted: 7713, moved: false, blocked: null }, "linux", {}),
      ).toMatchObject({ status: "warn" });
      expect(await httpCheck(null, "linux", {})).toMatchObject({ status: "warn" });
      // A server that answers everything 200 with no policy: the self-test names each problem.
      const plain = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
      });
      await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
      const address = plain.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      try {
        const problems = await selfTest(port);
        expect(problems).toContain("Host evil.example got 200, not 421");
        expect(problems).toContain("index.html has no CSP nonce");
        const check = await httpCheck(
          { port, persisted: 7713, moved: true, blocked: null },
          "linux",
          {},
        );
        expect(check.status).toBe("fail");
        expect(check.detail).toContain(movedMessage(7713, port));
      } finally {
        await new Promise((resolve) => plain.close(resolve));
      }
      expect(
        excludedRanges(
          "\nProtocol tcp Port Exclusion Ranges\n\nStart Port    End Port\n----------    --------\n      7680        7680\n     50000       50059     *\n\n* - Administered port exclusions.\n",
        ),
      ).toEqual([
        [7680, 7680],
        [50000, 50059],
      ]);
    },
  );
});
