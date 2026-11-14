// Test helpers for the request path: an rpc session of a chosen CLI class with a running service,
// and the error body of a failed call. Tests only.
import { openRpc, RpcError, type RpcSession } from "@tasks/bridge/protocol";
import type { ErrorBody } from "@tasks/contracts";
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
