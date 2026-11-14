// The process the update crash tests kill (A7 3.13 M6.12 and M6.13, the crash harness's pattern of
// A1 5): it runs the updater (or `tasks update --repair`) from source against a real test install,
// with seams armed at one named step. It reads its task from stdin as one JSON line, then reports
// each step it reaches as a JSON line on stdout with a synchronous write. At the armed step it
// says so and blocks its thread until the parent kills it, or, when the parent killed the service
// instead, until the parent writes the `go` file. Only this entry arms seams: the product passes
// none.
//
// The service is reached through the service install's context (M1.12) with stand-in tools: no
// user manager, no Explorer, and a start that runs the install's stable command `serve` detached,
// as a manual start does. So no test restarts a real service or touches a real autostart place.
import { spawn } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { FakeService, FakeTools } from "../../packages/service/test/install-fakes.ts";
import { hostFacts } from "../../packages/service/src/hub/paths.ts";
import { defaultServiceContext } from "../../packages/service/src/install/context.ts";
import {
  launcherSelfTest,
  osServiceControl,
  repairUpdate,
  updateFromArchive,
  UpdateError,
  type UpdateOptions,
} from "../../packages/service/src/version/update.ts";

export interface ChildTask {
  readonly task: "update" | "repair";
  readonly root: string;
  readonly archive?: string;
  readonly keys: readonly string[];
  /** The step to stop at: an update point or a repair point. */
  readonly arm?: string;
  /** The parent writes this file to let a stopped child go on. */
  readonly go: string;
  /** The stable command, which the stand-in start runs as `serve`. */
  readonly stable: string;
  /** The environment of the programs it starts: no Tasks variable, no agent marker. */
  readonly env: Record<string, string>;
  /**
   * The candidate's self-test: `real` (the default) through its own launcher, or `pass`, a stand-in
   * for tests of the steps after it (the launchers' swap), so each round costs no self-test.
   */
  readonly selfTest?: "real" | "pass";
}

const line = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};

const sleep = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

async function readTask(): Promise<ChildTask> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += (chunk as Buffer).toString("utf8");
    if (text.includes("\n")) break;
  }
  return JSON.parse(text.slice(0, text.indexOf("\n"))) as ChildTask;
}

const task = await readTask();

const at = (point: string): void => {
  line({ at: point });
  if (point !== task.arm) return;
  line({ armed: point });
  // Blocks this thread: nothing of the updater runs until the parent kills it or lets it go.
  while (!existsSync(task.go)) sleep(20);
  line({ resumed: point });
};

const env = { ...task.env, TASKS_HOME: task.root };
const real = defaultServiceContext({ env, program: task.stable });
const tools = new FakeTools(new FakeService(), join(task.root, "no-units"), {
  userManager: false,
  explorer: false,
});
const ctx = {
  ...real,
  run: tools.run,
  windows: undefined,
  roots: { ...real.roots, unitDir: join(task.root, "no-units") },
  // A manual start: the install's stable command `serve`, detached, outliving this process.
  startDetached: () => {
    const child = spawn(task.stable, ["serve"], {
      env: task.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  },
};

const options: UpdateOptions = {
  facts: hostFacts(env, process.platform),
  keys: task.keys,
  control: osServiceControl(ctx, env),
  selfTest:
    task.selfTest === "pass"
      ? () => Promise.resolve({ ok: true, failed: [] })
      : launcherSelfTest(task.env, process.platform),
  // A launcher's steps are armed by `<point>:<name>`, for example `aside:tasks.exe`.
  seams: {
    update: at,
    at,
    launcher: (point, name) => {
      at(`${point}:${name}`);
    },
  },
  say: (said) => {
    line({ say: said });
  },
};

try {
  const result =
    task.task === "update"
      ? await updateFromArchive(task.archive ?? "", options)
      : await repairUpdate(options);
  line({ done: result.outcome });
  process.exit(0);
} catch (error) {
  line({
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof UpdateError ? error.exitCode : 70,
  });
  process.exit(error instanceof UpdateError ? error.exitCode : 70);
}
