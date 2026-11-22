// Test helpers for the request path: an rpc session of a chosen CLI class with a running service,
// the error body of a failed call, and agent homes registered and revoked as setup does. Tests
// only.
import { join } from "node:path";
import { openRpc, RpcError, type RpcSession } from "@ttasks/bridge/protocol";
import type { ErrorBody } from "@ttasks/contracts";
import { keyOf, within } from "./harness.ts";

export type CliClass = "cli-interactive" | "cli-script" | "cli-agent";

/**
 * A session of class `cls`: the class comes from `client.tty` and the agent markers in the bind
 * context, as the service decides it (A2 3.6.5). `cli-agent` needs a marker in `env`.
 */
export function classSession(
  home: string,
  path: string,
  cls: CliClass,
  env: Record<string, string> = {},
): Promise<RpcSession> {
  const tty = cls === "cli-interactive";
  return within(
    openRpc({
      path,
      key: keyOf(home),
      client: {
        kind: "cli",
        version: "0.0.0-test",
        build: "test",
        pid: process.pid,
        package: null,
        tty: { stdin: tty, stdout: tty },
      },
      context: { env },
    }),
    20_000,
    "the handshake",
  );
}

/** The A3 error body an rpc call failed with. */
export function errorOf(error: unknown): ErrorBody {
  if (!(error instanceof RpcError)) throw new Error(`expected an rpc error, got ${String(error)}`);
  return error.data as ErrorBody;
}

/** An agent home to register: its instance and the space its entry names. */
export interface HomeRow {
  readonly instance: string;
  readonly space: string;
  /** The account label; default none. Another label replaces the home's row. */
  readonly account?: string;
}

/**
 * The agent home of an instance in the tests' worlds: its app, and a folder of the test's home that
 * nothing reads, one per instance. A world's launch records it at its click, and `grantHome`
 * registers it, so the two name the same home as a real click and setup do.
 */
export const agentHomeOf = (home: string, instance: string): { app: string; home: string } => ({
  app: "codex",
  home: join(home, "agent-homes", instance),
});

/**
 * Registers an agent home for a space as `ttasks setup agents --apply` does, through the user's
 * `setup/home_grant` (A3 3.7.4): one live agent-home row of the instance naming the space, so its
 * MCP connections pass the grant gate. The home is the instance's (`agentHomeOf`), so granting the
 * instance again replaces its row. Returns the row's ID.
 */
export async function grantHome(
  home: string,
  path: string,
  row: HomeRow,
  session?: RpcSession,
): Promise<string> {
  const user = session ?? (await classSession(home, path, "cli-interactive"));
  try {
    const agent = agentHomeOf(home, row.instance);
    const answer = (await user.call(
      "setup/home_grant",
      {
        app: agent.app,
        home: agent.home,
        instance: row.instance,
        account: row.account ?? "",
        space: row.space,
      },
      { timeoutMs: 60_000 },
    )) as { grant: { grant: string } };
    return answer.grant.grant;
  } finally {
    if (session === undefined) user.close();
  }
}

/** Revokes agent-home rows as `ttasks setup agents --remove` does (`setup/home_revoke`). */
export async function revokeHome(
  home: string,
  path: string,
  grants: string[],
  session?: RpcSession,
): Promise<number> {
  const user = session ?? (await classSession(home, path, "cli-interactive"));
  try {
    const answer = (await user.call("setup/home_revoke", { grants }, { timeoutMs: 60_000 })) as {
      revoked: number;
    };
    return answer.revoked;
  } finally {
    if (session === undefined) user.close();
  }
}
