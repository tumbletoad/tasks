// A fake `t3` command line (A4 3.4.1 "Fallback route: `t3-cli`"; M6.10): what the T3 CLI route
// starts in place of the real `t3`. It needs a running fake T3 server, as the real CLI is assumed
// to need T3's server: it reads the server's origin from `$T3CODE_HOME/userdata/server-runtime.json`
// and hands its argv and stdin to the fake (FakeT3's `/fake-cli`), which does the work in its own
// state and says what to print and how to exit. Before that it appends one JSON line to
// FAKE_T3_CLI_LOG (when set): its argv exactly as it got it (with each element's UTF-8 bytes in hex),
// the folder it started in, its environment's names and the two variables a T3 shim sets, and its
// stdin. Fixture data only. No fake outlives its test: a hang ends after FAKE_T3_CLI_MAX_MS.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One line of the fake CLI's log. */
export interface FakeT3CliRecord {
  readonly argv: string[];
  /** Each argv element's UTF-8 bytes, in hex: what reached the process, byte for byte. */
  readonly hex: string[];
  readonly cwd: string;
  readonly envNames: string[];
  readonly home: string | null;
  readonly electron: string | null;
  readonly stdin: string | null;
}

/** What the fake server tells the fake CLI to do. */
export interface FakeT3CliAnswer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly hang?: boolean;
}

const argv = process.argv.slice(2);
// Only `thread start <target> -` reads its message from stdin; every other command leaves it.
const fromStdin = argv[0] === "thread" && argv[1] === "start" && argv[3] === "-";
const stdin = fromStdin ? readFileSync(0, "utf8") : null;
const log = process.env["FAKE_T3_CLI_LOG"];
if (log !== undefined && log !== "") {
  const record: FakeT3CliRecord = {
    argv,
    hex: argv.map((arg) => Buffer.from(arg, "utf8").toString("hex")),
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
    home: process.env["T3CODE_HOME"] ?? null,
    electron: process.env["ELECTRON_RUN_AS_NODE"] ?? null,
    stdin,
  };
  appendFileSync(log, `${JSON.stringify(record)}\n`);
}

const max = Number(process.env["FAKE_T3_CLI_MAX_MS"] ?? "120000");

function origin(): string | undefined {
  const home = process.env["T3CODE_HOME"];
  if (home === undefined || home === "") return undefined;
  try {
    const value = JSON.parse(
      readFileSync(join(home, "userdata", "server-runtime.json"), "utf8"),
    ) as { origin?: unknown };
    return typeof value.origin === "string" ? value.origin : undefined;
  } catch {
    return undefined;
  }
}

const at = origin();
if (at === undefined) {
  process.stderr.write("T3 Code is not running.\n");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`${at}/fake-cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, stdin }),
    });
    const answer = (await response.json()) as FakeT3CliAnswer;
    if (answer.hang === true) {
      setTimeout(() => {
        process.exit(1);
      }, max);
    } else {
      process.stdout.write(answer.stdout);
      process.stderr.write(answer.stderr);
      process.exitCode = answer.code;
    }
  } catch {
    process.stderr.write("T3 Code did not answer.\n");
    process.exitCode = 1;
  }
}
