// The ttasks-launchd wrapper (A2 3.3.4) with a stub service, under the POSIX shells at hand: /bin/sh
// (dash on Ubuntu) and bash in POSIX mode, which is what macOS's /bin/sh is. launchd itself is not
// here: it waits for a Mac (A2 6 item 5). Linux and macOS hosts only.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LAUNCHD_WRAPPER } from "../src/install/render.ts";

const posix = process.platform !== "win32";
const SHELLS: (readonly string[])[] = [
  ["/bin/sh"],
  ...(existsSync("/bin/bash") ? [["/bin/bash", "--posix"]] : []),
];

/**
 * The stub `ttasks`: its n-th start follows line n of `plan`. A number exits with it; `term:<code>`
 * writes `ready.<n>`, waits for SIGTERM, notes it and exits with <code>. Each start is a line in
 * `starts`, with its PID.
 */
const STUB = `#!/bin/sh
dir=\${0%/bin/ttasks}
n=$(grep -c . "$dir/starts")
echo "start $$ $*" >> "$dir/starts"
step=$(sed -n "$((n + 1))p" "$dir/plan")
case $step in
  term:*)
    trap 'echo "got TERM" >> "$dir/events"; exit '"\${step#term:}" TERM
    : > "$dir/ready.$n"
    while :; do sleep 0.05; done ;;
  *) exit "\${step:-0}" ;;
esac
`;

let dir = "";
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-launchd-")));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "ttasks-launchd"), LAUNCHD_WRAPPER);
  writeFileSync(join(dir, "bin", "ttasks"), STUB);
  chmodSync(join(dir, "bin", "ttasks-launchd"), 0o755);
  chmodSync(join(dir, "bin", "ttasks"), 0o755);
  writeFileSync(join(dir, "starts"), "");
});

afterEach(() => {
  // A stub that still waits (a failed test) is a process this test started: end it by its PID.
  for (const line of readFileSync(join(dir, "starts"), "utf8").split("\n")) {
    const pid = Number(line.split(" ")[1]);
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Wrapper {
  readonly pid: number;
  readonly exit: Promise<number | null>;
}

function wrapper(shell: readonly string[], plan: readonly string[]): Wrapper {
  writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`);
  const [file = "/bin/sh", ...flags] = shell;
  const child = spawn(file, [...flags, join(dir, "bin", "ttasks-launchd")], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("the wrapper did not start");
  return {
    pid: child.pid,
    exit: new Promise((resolve) => {
      child.once("exit", (code) => {
        resolve(code);
      });
    }),
  };
}

const starts = () =>
  readFileSync(join(dir, "starts"), "utf8")
    .split("\n")
    .filter((line) => line !== "");

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!posix)(
  "[A2.3.3.4.service-install.launchd-wrapper] ttasks-launchd with a stub service",
  () => {
    for (const shell of SHELLS) {
      const name = shell.join(" ");

      test(`${name}: 0, 64 and 73 exit 0; 70 and other crashes pass through; 75 starts again at once`, async () => {
        for (const [plan, code, count] of [
          [["0"], 0, 1],
          [["64"], 0, 1],
          [["73"], 0, 1],
          [["70"], 70, 1],
          [["1"], 1, 1],
          [["75", "75", "0"], 0, 3],
          [["75", "64"], 0, 2],
          [["75", "70"], 70, 2],
        ] as const) {
          writeFileSync(join(dir, "starts"), "");
          expect(await wrapper(shell, plan).exit).toBe(code);
          expect(starts()).toHaveLength(count);
          expect(starts().every((line) => line.endsWith(" serve"))).toBe(true);
        }
      });

      test(`${name}: more than 5 restarts on 75 in a row exit 75, so launchd's throttle bounds them`, async () => {
        expect(await wrapper(shell, ["75", "75", "75", "75", "75", "75", "0"]).exit).toBe(75);
        expect(starts()).toHaveLength(6);
      });

      test(`${name}: SIGTERM reaches the service and a stop always ends in 0, also during a 75 restart`, async () => {
        for (const [plan, count] of [
          [["term:0"], 1],
          [["term:70"], 1],
          [["term:75", "0"], 1],
        ] as const) {
          writeFileSync(join(dir, "starts"), "");
          rmSync(join(dir, "events"), { force: true });
          rmSync(join(dir, "ready.0"), { force: true });
          const run = wrapper(shell, plan);
          await until(() => existsSync(join(dir, "ready.0")));
          process.kill(run.pid, "SIGTERM");
          expect(await run.exit).toBe(0);
          expect(readFileSync(join(dir, "events"), "utf8")).toBe("got TERM\n");
          expect(starts()).toHaveLength(count);
        }
      });
    }
  },
);
