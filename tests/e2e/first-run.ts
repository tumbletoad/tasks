// A fresh install for the first-start tests: a real service process (serve-entry.ts) in a temporary
// TASKS_HOME with no space and no machine.toml, and a scratch home with a Claude Code and a Codex
// home, whose commands are testkit's fakes (fake-agents.ts): they refuse any file outside that home.
// Sign-in goes the way `tasks open` goes. Tests only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "../../packages/brand/src/index.ts";
import type { RpcSession } from "../../packages/bridge/src/protocol/index.ts";
import {
  configOf,
  removeRuntimeDir,
  Services,
  tempRoot,
  waitReady,
  within,
  type ServiceJson,
} from "../../packages/service/test/harness.ts";
import { post } from "../../packages/service/test/http-client.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import { installFakeAgents } from "../../packages/testkit/src/fake-agents.ts";

const ENTRY = fileURLToPath(new URL("./serve-entry.ts", import.meta.url));

/** Generous bounds: a loaded machine must not fail a test that is only slow. */
export const SLOW_MS = 120_000;

const REDEEMS_PER_WINDOW = 10;
const REDEEM_WINDOW_MS = 60_000;

export interface FreshWorld {
  readonly origin: string;
  /** The scratch home the agent apps are found in. */
  readonly agentHome: string;
  /** Where a new space goes unless the person picks a folder. */
  readonly spaces: string;
  /** The `tasks open` URL of a fresh code, landing on `to`. */
  signInUrl(to: string): Promise<string>;
  /** Sets one of this computer's settings as the page does, or resets it with null. */
  machine(key: string, value: unknown): Promise<void>;
  /** An operation as the person at a terminal makes it. */
  op(space: string, op: string, input: Record<string, unknown>): Promise<unknown>;
  /** Closes and forgets every space, so the page starts from no space again. Their folders stay. */
  forgetSpaces(): Promise<void>;
  /** Tasks's entry in the scratch Claude Code home, or undefined. */
  claudeEntry(): unknown;
  /** The scratch Codex home's config.toml, or "" when there is none. */
  codexConfig(): string;
  /** Another program changes the Codex home's config.toml. */
  touchCodex(): void;
  /** machine.toml's text, or "" when there is none. */
  machineToml(): string;
  close(): Promise<void>;
}

export async function startFresh(ui: string): Promise<FreshWorld> {
  const temp = tempRoot("e2e-fresh");
  const services = new Services();
  let json: ServiceJson | undefined;
  const sessions: RpcSession[] = [];
  try {
    const home = join(temp.root, "h");
    const agentHome = join(temp.root, "u");
    mkdirSync(join(agentHome, ".claude"), { recursive: true });
    mkdirSync(join(agentHome, ".codex"), { recursive: true });
    const fakes = installFakeAgents(join(temp.root, "fakes"), agentHome);
    // The installed command the agents' entries run. Nothing runs it in these tests.
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(
      join(home, "bin", process.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME),
      "",
    );
    const record = join(temp.root, "terminal.jsonl");
    writeFileSync(record, "");
    const proc = services.start(home, {
      script: ENTRY,
      env: {
        E2E_UI: ui,
        E2E_TERMINAL: record,
        E2E_AGENT_HOME: agentHome,
        E2E_AGENT_ENV: JSON.stringify(fakes.env),
      },
    });
    json = await waitReady(home, proc.pid);
    const endpoint = json.endpoint?.path;
    const http = json["http"] as { port?: number } | null;
    if (endpoint === undefined || typeof http?.port !== "number") {
      throw new Error("the service reports no endpoint or UI port");
    }
    const origin = `http://127.0.0.1:${String(http.port)}`;
    const user = await classSession(home, endpoint, "cli-interactive");
    sessions.push(user);
    const redeems: number[] = [];
    let token: string | undefined;
    let ops = 0;
    const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const userCall = (method: string, params: Record<string, unknown>) =>
      user.call(method, params, { timeoutMs: SLOW_MS }) as Promise<Record<string, unknown>>;
    return {
      origin,
      agentHome,
      spaces: join(home, "spaces"),
      signInUrl: async (to) => {
        // The service redeems at most 10 codes a minute: wait for room rather than be signed out.
        const now = Date.now();
        while (redeems.length > 0 && (redeems[0] ?? 0) <= now - REDEEM_WINDOW_MS) redeems.shift();
        if (redeems.length >= REDEEMS_PER_WINDOW) {
          const wait = (redeems[0] ?? now) + REDEEM_WINDOW_MS + 250 - now;
          await new Promise((resolve) => setTimeout(resolve, wait));
          redeems.shift();
        }
        redeems.push(Date.now());
        const minted = (await userCall("ui/mint_code", {})) as { code: string; port: number };
        return `http://127.0.0.1:${String(minted.port)}/#k=${minted.code}&to=${encodeURIComponent(to)}`;
      },
      machine: async (key, value) => {
        const port = Number(new URL(origin).port);
        if (token === undefined) {
          redeems.push(Date.now());
          const minted = (await userCall("ui/mint_code", {})) as { code: string };
          const signed = await post(port, "/api/v1/auth/redeem", { code: minted.code });
          token = (JSON.parse(signed.body) as { token: string }).token;
        }
        const reply = await post(port, "/api/v1/machine/pref", { key, value }, { token });
        if (reply.status !== 200) throw new Error(`machine/pref answered ${String(reply.status)}`);
      },
      op: async (space, op, input) => {
        ops += 1;
        return userCall("op/call", {
          space,
          op,
          input: { ...input, request_id: `e2e-fresh-op-${String(ops).padStart(4, "0")}` },
        });
      },
      forgetSpaces: async () => {
        const listed = (await userCall("space/list", {}))["spaces"] as {
          folder: string;
          state: string;
        }[];
        for (const space of listed) {
          if (space.state !== "closed") await userCall("space/close", { space: space.folder });
          await userCall("space/forget", { space: space.folder });
        }
      },
      claudeEntry: () => {
        const text = read(join(agentHome, ".claude.json"));
        if (text === "") return undefined;
        const doc = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
        return doc.mcpServers?.["tasks"];
      },
      codexConfig: () => read(join(agentHome, ".codex", "config.toml")),
      touchCodex: () => {
        appendFileSync(join(agentHome, ".codex", "config.toml"), '\nmodel = "o4"\n');
      },
      machineToml: () => read(join(configOf(home), "machine.toml")),
      close: async () => {
        for (const s of sessions.splice(0)) s.close();
        proc.send("stop");
        await within(proc.exit, SLOW_MS, "the service did not stop").catch(() =>
          services.stopAll(),
        );
        removeRuntimeDir(json);
        temp.cleanup();
      },
    };
  } catch (error) {
    for (const s of sessions.splice(0)) s.close();
    await services.stopAll();
    removeRuntimeDir(json);
    if (existsSync(temp.root)) temp.cleanup();
    throw error;
  }
}
