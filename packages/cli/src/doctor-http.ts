// Doctor's HTTP and accounts rows: the UI's port moved or blocked by another program's listener,
// a port in a Windows excluded range, the Host and Origin self-test (a request with
// `Host: evil.example` must get 421), a CSP with a fresh nonce on index.html, and how many other
// user accounts the machine has. Only codes, counts and ports reach the output: never a token,
// name or SID.
import { win32 } from "node:path";
import { helperOutput } from "@ttasks/launch/helpers";
import {
  blockedMessage,
  metaContent,
  movedMessage,
  portUnsaved,
  unsavedMessage,
} from "@ttasks/service/http/shared";
import { countAccounts, type AccountFacts } from "./accounts.ts";
import { listenerRequest } from "./listener-request.ts";

/** A doctor row (doctor.ts has the same shape). */
export interface Check {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "skip";
  readonly detail: string;
}

/** The `http` field of `service/status`. */
export interface HttpStatusView {
  readonly port?: number | null;
  readonly persisted?: number | null;
  readonly moved?: boolean;
  readonly blocked?: string | null;
}

interface Answer {
  readonly status: number;
  readonly csp: string;
  readonly body: string;
}

/** A GET's deadline for the whole exchange, and the most of a page it reads. */
const GET_MS = 5_000;
const GET_MAX_BYTES = 256 * 1024;

/** One GET of the listener with a chosen Host header, within `deadlineMs`. */
async function get(
  port: number,
  path: string,
  host: string,
  deadlineMs: number,
): Promise<Answer | undefined> {
  const answer = await listenerRequest(port, {
    method: "GET",
    path,
    headers: { Host: host },
    deadlineMs,
    maxBytes: GET_MAX_BYTES,
  });
  if (answer === undefined) return undefined;
  return {
    status: answer.status,
    csp: String(answer.headers["content-security-policy"] ?? ""),
    body: answer.body,
  };
}

const nonceOf = (answer: Answer | undefined): string | undefined =>
  answer === undefined ? undefined : /'nonce-([A-Za-z0-9+/=]+)'/.exec(answer.csp)?.[1];

/**
 * The listener's self-test: a rebinding Host is refused, and the shell's nonce is fresh. Each of
 * its requests ends within `deadlineMs` (5 s), whatever answers on the port.
 */
export async function selfTest(port: number, deadlineMs = GET_MS): Promise<string[]> {
  const problems: string[] = [];
  const evil = await get(port, "/healthz", "evil.example", deadlineMs);
  if (evil?.status !== 421)
    problems.push(`Host evil.example got ${String(evil?.status ?? "no answer")}, not 421`);
  const own = `127.0.0.1:${String(port)}`;
  const first = await get(port, "/", own, deadlineMs);
  const second = await get(port, "/", own, deadlineMs);
  const n1 = nonceOf(first);
  const n2 = nonceOf(second);
  if (first?.status !== 200 || n1 === undefined) problems.push("index.html has no CSP nonce");
  else if (n1 === n2) problems.push("index.html's nonce is not fresh");
  // The tag as a browser reads it (React Aria's `meta[name="csp-nonce"]`), in any spelling a build
  // writes: the same reader as the service's check of a built page.
  else if (metaContent(first.body, "csp-nonce") !== n1)
    problems.push("index.html's meta tag does not repeat the nonce");
  if (first !== undefined && !first.csp.includes("worker-src 'none'"))
    problems.push("the CSP lacks worker-src 'none'");
  if (first !== undefined && /unsafe-inline|unsafe-eval/.test(first.csp))
    problems.push("the CSP allows unsafe code");
  return problems;
}

/** Windows: the excluded port ranges of `netsh interface ipv4 show excludedportrange`. */
export function excludedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(?:\s|$)/.exec(line);
    if (match !== null) ranges.push([Number(match[1]), Number(match[2])]);
  }
  return ranges;
}

/** netsh runs as a helper of the runner (@ttasks/launch helpers.ts). */
async function windowsExcluded(
  port: number,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const system = env["SystemRoot"] ?? "C:\\Windows";
  const out = await helperOutput(
    [
      win32.join(system, "System32", "netsh.exe"),
      "interface",
      "ipv4",
      "show",
      "excludedportrange",
      "protocol=tcp",
    ],
    // netsh runs in this process's environment, as it always has.
    { env: process.env, cwd: system, deadlineMs: 15_000, maxChars: 1024 * 1024 },
  );
  if (out === undefined) return false;
  return excludedRanges(out).some(([lo, hi]) => lo <= port && port <= hi);
}

/** The `http` row from a running service's status. */
export async function httpCheck(
  http: HttpStatusView | null | undefined,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Check> {
  if (http === null || http === undefined) {
    return { id: "http", status: "warn", detail: "The service runs no UI listener." };
  }
  if (http.blocked !== null && http.blocked !== undefined) {
    return { id: "http", status: "fail", detail: blockedMessage(http.port ?? null) };
  }
  const port = http.port ?? null;
  if (port === null) return { id: "http", status: "warn", detail: "The UI listener has no port." };
  const notes: string[] = [];
  let status: Check["status"] = "ok";
  if (http.moved === true && typeof http.persisted === "number") {
    status = "warn";
    notes.push(movedMessage(http.persisted, port));
    if (platform === "win32" && (await windowsExcluded(http.persisted, env))) {
      notes.push(`Port ${String(http.persisted)} lies in a Windows excluded port range.`);
    }
  }
  if (portUnsaved(http)) {
    status = "warn";
    notes.push(unsavedMessage(port));
  }
  const problems = await selfTest(port);
  if (problems.length > 0) {
    status = "fail";
    notes.push(`Self-test: ${problems.join("; ")}.`);
  }
  return {
    id: "http",
    status,
    detail:
      notes.length === 0
        ? `Listening on 127.0.0.1:${String(port)}; Host and CSP self-test passed.`
        : notes.join(" "),
  };
}

/** The `accounts` row: information, never a warning. */
export function accountsCheck(facts: AccountFacts | undefined): Check {
  if (facts === undefined) {
    return { id: "accounts", status: "skip", detail: "The machine's accounts could not be read." };
  }
  const { others, sandbox } = countAccounts(facts);
  const count = others === 0 ? "No" : String(others);
  const left =
    sandbox === 0
      ? ""
      : ` (not counting ${String(sandbox)} agent sandbox account${sandbox === 1 ? "" : "s"})`;
  return {
    id: "accounts",
    status: "ok",
    detail: `${count} other user account${others === 1 ? "" : "s"} on this machine${left}.`,
  };
}
