// The browser test world owns each shim so its lifetime is independent of service restarts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "../../packages/brand/src/index.ts";
import {
  instanceToml,
  serviceEnv,
  type Proc,
  type Services,
} from "../../packages/service/test/harness.ts";
import { FAKE_CLI_AGENT } from "../../packages/testkit/src/index.ts";

/** The CLI's entry from the source tree, as `pnpm ttasks` runs it. */
const CLI_BIN = fileURLToPath(new URL("../../packages/cli/src/bin.ts", import.meta.url));
const FAILING_AGENT_SHIM = fileURLToPath(new URL("./failing-agent-shim.ts", import.meta.url));

/** The one instance the page offers: the fake agent, as machine.toml's `[[instance]]` has it. */
export const FAKE_INSTANCE = {
  key: "fake-agent",
  label: "Claude Code",
  glyph: "Cc",
  ring: 1,
  route: "terminal",
} as const;

/** Another agent a world offers: the fake agent under its own key, app and label. */
export interface FakeAgent {
  readonly key: string;
  readonly target: "claude-cli" | "codex-cli";
  readonly label: string;
}

/**
 * The instance's table in machine.toml: Claude Code's target, run as the fake, which reads the
 * person's request as its brief says without the tools (`ttasks show --launch`) from the install of
 * `home`. On a task `holds` has a file for, the fake runs until that file is removed.
 */
export function fakeInstanceToml(
  home: string,
  holds: string,
  as: FakeAgent = { key: FAKE_INSTANCE.key, target: "claude-cli", label: FAKE_INSTANCE.label },
): string {
  return instanceToml({
    id: as.key,
    target: as.target,
    label: as.label,
    exec: process.execPath,
    args_prefix: [FAKE_CLI_AGENT],
    env: {
      // Long enough to settle (3 s), short enough to end on its own.
      FAKE_CLI_HOLD_MS: "6000",
      FAKE_CLI_TASKS: JSON.stringify({ argv: [process.execPath, CLI_BIN], home }),
      FAKE_CLI_HOLDS: holds,
    },
  });
}

/** One shim the world started. */
export interface TerminalCall {
  readonly launch: string;
  readonly argv: readonly string[];
  /** The shim's process, which a test may end as a closed window or a kill would. */
  readonly pid: number;
}

export interface TerminalRequest {
  readonly launch: string;
  readonly task: string | null;
  readonly ticket: string;
  readonly folder: string;
}

export interface TerminalReply {
  readonly launch: string;
  readonly kind: "accepted" | "refused";
}

export class FakeTerminal {
  readonly calls: TerminalCall[] = [];
  readonly refuse: string[] = [];
  failNextAgent = false;
  readonly #exits: Promise<void>[] = [];
  #closing = false;

  startService(services: Services, home: string, env: Record<string, string>): Proc {
    const proc = services.start(home, {
      script: fileURLToPath(new URL("./serve-entry.ts", import.meta.url)),
      env,
      ipc: true,
    });
    const shimEnv = serviceEnv(home, env);
    proc.child.on("message", (request: TerminalRequest) => {
      this.#open(request, shimEnv, (kind) => {
        proc.child.send({ launch: request.launch, kind } satisfies TerminalReply);
      });
    });
    return proc;
  }

  #open(
    { launch, task, ticket, folder }: TerminalRequest,
    env: NodeJS.ProcessEnv,
    reply: (kind: TerminalReply["kind"]) => void,
  ): void {
    if (this.#closing) {
      reply("refused");
      return;
    }
    const at = task === null ? -1 : this.refuse.indexOf(task);
    if (at !== -1) {
      this.refuse.splice(at, 1);
      reply("refused");
      return;
    }
    const script = this.failNextAgent ? FAILING_AGENT_SHIM : CLI_BIN;
    this.failNextAgent = false;
    const shim = spawn(process.execPath, [script, "shim", ticket], {
      cwd: folder,
      env,
      // The agent inherits stderr, so close also waits for an agent whose shim was killed.
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    shim.stderr.resume();
    this.#exits.push(
      new Promise<void>((resolve) => {
        shim.once("close", () => {
          resolve();
        });
      }),
    );
    shim.once("error", () => {
      reply("refused");
    });
    shim.once("spawn", () => {
      if (shim.pid === undefined) throw new Error("the spawned shim has no PID");
      this.calls.push({ launch, argv: [CLI_NAME, "shim", ticket], pid: shim.pid });
      reply("accepted");
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.#exits);
  }
}
