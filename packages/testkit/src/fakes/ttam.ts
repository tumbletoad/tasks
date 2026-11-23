// A fake `ttam query`, built from one of TTAM's recorded conversations (fixtures/ttam/): it writes
// the recording's hello, answers the n-th request it serves with the recording's n-th snapshot (the
// last one again after that), and keeps TTAM's rules: one request served and one waiting, `busy`
// for a further one, the recorded errors for a line that is no request, the permission the
// recording applied in `usage`, and exit 0 when its input ends or `end` comes, with no answer to a
// request still served. It runs as `node ttam.ts --conversation=<file> [--mode=<mode>] query`.
//
// --mode makes it misbehave:
//   no_query     exits 2 at once, as a build without `ttam query` does
//   silent       writes no hello
//   not_hello    writes a snapshot line where the hello belongs
//   version=S,Q  its hello names schema version S and query version Q
//   busy         answers its first request with `busy`, then as usual
//   garbage      answers with a line that is no JSON
//   long         answers with a line of 9 MiB
//   bad_shape    answers with a snapshot whose `agents` is no list
//   slow=MS      every pass takes MS
//   stall        writes half an answer, then reads no input and writes nothing more
//   deaf         writes its hello, then reads no input and never ends by itself
//   die          writes half an answer, then exits 1
//   after_end    at its end writes one more answer and half a line before it exits
//
// --log=<file> gets a JSON line with its PID at the start, so a test can see that it is gone, and
// one with each `get`'s ID and usage. Fixture data only. No fake outlives its test: it ends after --max-ms (default 120 s) whatever it does.
import { appendFileSync, readFileSync } from "node:fs";

const options = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const at = arg.indexOf("=");
      return at === -1 ? [arg.slice(2), ""] : [arg.slice(2, at), arg.slice(at + 1)];
    }),
);
const mode = options.get("mode") ?? "";
const log = options.get("log");
if (log !== undefined) appendFileSync(log, `${JSON.stringify({ pid: process.pid })}\n`);
setTimeout(() => process.exit(3), Number(options.get("max-ms") ?? "120000")).unref();

if (process.argv.at(-1) !== "query" || mode === "no_query") {
  process.stderr.write("error: unrecognized subcommand\n");
  process.exit(2);
}

interface Entry {
  readonly from: "ttam" | "consumer";
  readonly line?: string;
}

const records = readFileSync(options.get("conversation") ?? "", "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as Entry);
const written = records.flatMap((r) =>
  r.from === "ttam" && r.line !== undefined ? [JSON.parse(r.line) as Record<string, unknown>] : [],
);
const hello = written.find((line) => line["type"] === "hello") ?? {};
const snapshots = written.filter((line) => line["type"] === "snapshot");
// The recording's own configuration: usage queries off when a `live` request got `cached`.
const asked = new Map<unknown, unknown>();
for (const r of records) {
  if (r.from !== "consumer" || r.line === undefined) continue;
  try {
    const request = JSON.parse(r.line) as Record<string, unknown>;
    asked.set(request["id"], request["usage"]);
  } catch {
    // The recording's line that is no JSON.
  }
}
const usageOff = snapshots.some((s) => asked.get(s["id"]) === "live" && s["usage"] === "cached");

const passMs = mode.startsWith("slow=") ? Number(mode.slice(5)) : 10;
const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const half = (value: unknown): void => {
  const text = JSON.stringify(value);
  process.stdout.write(text.slice(0, Math.floor(text.length / 2)));
};

let served = 0;
let busyOnce = mode === "busy";
let ended = false;

function answer(id: number, usage: "cached" | "live"): Record<string, unknown> {
  const recorded = snapshots[Math.min(served, snapshots.length - 1)] ?? {};
  served += 1;
  const line: Record<string, unknown> = { ...recorded, id, usage: usageOff ? "cached" : usage };
  if (mode === "bad_shape") {
    line["snapshot"] = { ...(recorded["snapshot"] as object), agents: {} };
  }
  return line;
}

interface Request {
  readonly id: number;
  readonly usage: "cached" | "live";
}

let serving: Request | undefined;
let waiting: Request | undefined;

function serve(request: Request): void {
  serving = request;
  setTimeout(() => {
    if (ended) return;
    const line = answer(request.id, request.usage);
    if (mode === "garbage") process.stdout.write("this is not json\n");
    else if (mode === "long") process.stdout.write(`"${"x".repeat(9 * 1024 * 1024)}"\n`);
    else if (mode === "stall") {
      half(line);
      deafen();
      return;
    } else if (mode === "die") {
      half(line);
      process.exit(1);
    } else write(line);
    serving = undefined;
    const next = waiting;
    waiting = undefined;
    if (next !== undefined) serve(next);
  }, passMs);
}

function request(text: string): void {
  if (text.trim() === "") return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    write({ id: null, type: "error", code: "bad_json" });
    return;
  }
  const r = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const id = Number.isSafeInteger(r["id"]) ? (r["id"] as number) : null;
  if (r["type"] === "end") {
    end();
    return;
  }
  if (typeof r["type"] !== "string") {
    write({ id, type: "error", code: "bad_request" });
    return;
  }
  if (r["type"] !== "get") {
    write({ id, type: "error", code: "unknown_type" });
    return;
  }
  const usage = r["usage"] ?? "cached";
  if (id === null || (usage !== "cached" && usage !== "live")) {
    write({ id, type: "error", code: "bad_request" });
    return;
  }
  if (log !== undefined)
    appendFileSync(
      log,
      `${JSON.stringify({ pid: process.pid, get: id, usage })}
`,
    );
  if (busyOnce || (serving !== undefined && waiting !== undefined)) {
    busyOnce = false;
    write({ id, type: "error", code: "busy" });
    return;
  }
  if (serving === undefined) serve({ id, usage });
  else waiting = { id, usage };
}

function end(): void {
  if (ended) return;
  ended = true;
  if (mode === "after_end") {
    write(answer(0, "cached"));
    half(answer(0, "cached"));
  }
  process.stdout.write("", () => process.exit(0));
}

/** Reads nothing more and stays: only a kill ends it. */
function deafen(): void {
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
  setInterval(() => undefined, 60_000);
}

if (mode === "not_hello") write(snapshots[0]);
else if (mode.startsWith("version=")) {
  const [schema, query] = mode.slice(8).split(",").map(Number);
  write({ ...hello, schema_version: schema, query_version: query });
} else if (mode !== "silent") write(hello);

if (mode === "deaf") deafen();
else {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!ended) request(line);
    }
  });
  process.stdin.on("end", end);
}
