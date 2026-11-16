// A stand-in agent for the container tests: a program that behaves like one kind of agent process
// tree. How to start one and how to find what it left: stand-ins.ts.
//
//   node stand-in.ts <mode> --token=<token> [--max-ms=<n>]
//
// Modes of an agent:
//   behave       prints "ready", and on an interrupt prints "interrupted" and exits 0
//   fork-late    prints "ready", then after 300 ms starts an idle child every 100 ms, up to 10
//   detach       starts a detached idle child, and a detached child that starts a detached idle
//                grandchild and exits (on Linux: two new sessions, the grandchild a daemon whose
//                parent is gone), then exits 0 once both idle processes run
//   ignore-stop  ignores interrupts and SIGTERM and SIGHUP, as does its child, which prints
//                "child ready" once it does; prints "ignored" for each signal
//   hold-pipe    starts a detached idle child that shares its stdout and stderr, then exits 0
//   flood        writes 64 KiB chunks to stdout without end
//   die          prints "ready" and exits 3
//   handles      Linux: prints how many of the service's control pipes it holds ("leaked <n>").
//                Windows: prints the process that started it ("parent <pid>"). Then waits.
//   argv         prints the arguments after `--` as JSON and exits 0
//   nest         Linux: moves itself into a new cgroup below its own, prints "ready", waits
// Modes that talk Claude's stream (`claude -p --output-format stream-json`), for the run host:
//   talk         prints a message, and on an interrupt prints its result and exits 0
//   chatty       like talk, and prints another message every 200 ms
//   detach-stay  like talk, after it started a detached idle child and a daemonised grandchild
//   flood-answer prints 50 MB of other events, then a 1 MiB answer that escaping makes far longer,
//                and exits 0
//   huge-answer  prints an answer of 1.5 MiB and exits 0
//   answers      prints a new 256 KiB message every 10 ms without end
// Child roles: idle (waits), daemonize (starts a detached idle child, exits once it runs).
//
// Every process of a stand-in tree carries the token in its arguments, and on Windows also
// listens on the named pipe `tasks-test-standin-<token>-<pid>`, so the tests can count what is
// alive without trusting the container. None outlives --max-ms (default 60 s), so a broken
// container cannot leave a stand-in running for long.
import { spawn, type StdioOptions } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    "max-ms": { type: "string", default: "60000" },
  },
});
const mode = positionals[0] ?? "";
const token = values.token ?? "";
const maxMs = Number(values["max-ms"]);
if (!/^[a-z0-9]+$/.test(token) || !Number.isInteger(maxMs) || maxMs <= 0) process.exit(2);

const GUARD_EXIT = 124;
// Also what keeps a waiting stand-in alive.
setTimeout(() => process.exit(GUARD_EXIT), maxMs);

function say(text: string): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length;) {
    try {
      at += writeSync(1, bytes, at);
    } catch (error) {
      // A full non-blocking pipe: wait a moment. A closed one: nobody reads, which is no concern.
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

if (process.platform === "win32") {
  createServer()
    .listen(`\\\\.\\pipe\\tasks-test-standin-${token}-${String(process.pid)}`)
    .unref()
    .on("error", () => undefined);
}

/** Starts another process of the tree. */
function child(role: string, options: { detached?: boolean; stdio?: StdioOptions } = {}) {
  const started = spawn(
    process.execPath,
    [process.argv[1] ?? "", role, `--token=${token}`, `--max-ms=${String(maxMs)}`],
    {
      detached: options.detached ?? false,
      stdio: options.stdio ?? "ignore",
      windowsHide: true,
    },
  );
  started.on("error", () => undefined);
  if (options.detached === true) started.unref();
  return started;
}

const ignore = () => {
  say("ignored\n");
};
const ignoreStops = () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    if (signal === "SIGBREAK" && process.platform !== "win32") continue;
    if (signal === "SIGHUP" && process.platform === "win32") continue;
    process.on(signal, ignore);
  }
};

/** One event of Claude's stream. */
const event = (value: unknown): void => {
  say(`${JSON.stringify(value)}\n`);
};
const message = (text: string): void => {
  event({ type: "assistant", message: { content: [{ type: "text", text }] } });
};
const result = (text: string): void => {
  event({ type: "result", subtype: "success", is_error: false, result: text });
};

/** The answer of the flood-answer mode: 1 MiB, every byte of it a character JSON escapes. */
const FLOOD_ANSWER_UNIT = '"\\\n\t';

/** Talks, and answers an interrupt with its result. */
function talk(): void {
  process.on("SIGINT", () => {
    result("Stopped, with what was found so far.");
    process.exit(0);
  });
  message("Working on it.");
}

switch (mode) {
  case "talk":
    talk();
    break;
  case "chatty":
    talk();
    setInterval(() => {
      message("Still working on it.");
    }, 200);
    break;
  case "detach-stay":
    child("idle", { detached: true });
    child("daemonize", { detached: true }).once("exit", talk);
    break;
  case "flood-answer": {
    const pad = `{"type":"user","pad":"${"o".repeat(1024 * 1024 - 25)}"}\n`;
    for (let i = 0; i < 50; i += 1) say(pad);
    result(FLOOD_ANSWER_UNIT.repeat((1024 * 1024) / FLOOD_ANSWER_UNIT.length));
    process.exit(0);
    break;
  }
  case "huge-answer":
    result("€".repeat(512 * 1024));
    process.exit(0);
    break;
  case "answers": {
    let n = 0;
    setInterval(() => {
      n += 1;
      message(`${String(n).padStart(8, "0")}${"a".repeat(256 * 1024 - 8)}`);
    }, 10);
    break;
  }
  case "behave":
    process.on("SIGINT", () => {
      say("interrupted\n");
      process.exit(0);
    });
    say("ready\n");
    break;
  case "fork-late": {
    say("ready\n");
    let started = 0;
    setTimeout(() => {
      const timer = setInterval(() => {
        child("idle");
        started += 1;
        if (started >= 10) clearInterval(timer);
      }, 100);
    }, 300);
    break;
  }
  case "detach": {
    say("ready\n");
    child("idle", { detached: true });
    child("daemonize", { detached: true }).once("exit", () => {
      // The daemon's parent is gone: on Linux it now belongs to the user manager, not to us.
      process.exit(0);
    });
    break;
  }
  case "ignore-stop":
    ignoreStops();
    child("ignore-child", { stdio: ["ignore", "inherit", "ignore"] });
    say("ready\n");
    break;
  case "ignore-child":
    ignoreStops();
    say("child ready\n");
    break;
  case "hold-pipe":
    // Detached, because Node on Windows ends its other children when it exits.
    child("idle", { detached: true, stdio: ["ignore", "inherit", "inherit"] }).once("spawn", () => {
      say("ready\n");
      process.exit(0);
    });
    break;
  case "flood": {
    say("ready\n");
    const chunk = Buffer.alloc(64 * 1024, "x");
    const flood = () => {
      say(chunk.toString("latin1"));
      setImmediate(flood);
    };
    flood();
    break;
  }
  case "die":
    say("ready\n");
    process.exit(3);
    break;
  case "handles": {
    if (process.platform === "win32") {
      say(`parent ${String(process.ppid)}\n`);
      break;
    }
    // Node itself reuses low numbers for its own files, but never for a socket, which is what the
    // service's pipes are here.
    let leaked = 0;
    for (const fd of readdirSync("/proc/self/fd").map(Number)) {
      if (fd <= 2) continue;
      try {
        if (readlinkSync(`/proc/self/fd/${String(fd)}`).startsWith("socket:")) leaked += 1;
      } catch {
        // The listing's own descriptor is gone by now.
      }
    }
    say(`leaked ${String(leaked)}\n`);
    break;
  }
  case "nest": {
    // Linux: moves itself into a cgroup of its own below the run's.
    const own = readFileSync("/proc/self/cgroup", "utf8").trim().slice(3);
    const nested = join("/sys/fs/cgroup", own, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "cgroup.procs"), String(process.pid), { flag: "a" });
    say("ready\n");
    break;
  }
  case "argv":
    say(`${JSON.stringify(positionals.slice(1))}\n`);
    process.exit(0);
    break;
  case "idle":
    break;
  case "daemonize":
    child("idle", { detached: true }).once("spawn", () => {
      process.exit(0);
    });
    break;
  default:
    process.exit(2);
}
