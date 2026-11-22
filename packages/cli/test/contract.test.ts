// The contract suite (@ttasks/service/test/contract) through the CLI's --json (A3 5 "Parity", A7 3.9
// M2.03): every example goes in as `ttasks <verb> --input - --json`, the CLI's own path from the
// arguments to `op/call` and back, run in this process against a service in this process. The
// user's calls come from a terminal (`cli-interactive`), the agent's from a script (`cli-script`).
// The grant gate's refusal (A3 3.7.8) goes the same way, from an agent's shell whose ticket maps
// the call to a session of a home whose row was revoked (`cli-agent`).
import { expect } from "vitest";
import { EXIT_CODES, type ErrorBody } from "@ttasks/contracts";
import {
  ContractError,
  contractSuite,
  contractWorld,
  grantSuite,
  revokedSession,
  type ContractTransport,
} from "@ttasks/service/test/contract";
import { classSession, errorOf } from "@ttasks/service/test/ops-helpers";
import { CLI_SPEC } from "../src/args.ts";
import { runMain } from "./cli-harness.ts";

/** The verb of an entry: `note` for a note, `log` for the other entries of entry.add. */
function verbOf(entry: string, input: Record<string, unknown>): string {
  if (entry === "entry.add") return input["kind"] === "note" ? "note" : "log";
  const verb = CLI_SPEC.verbs.find((v) => v.entry === entry)?.verb;
  if (verb === undefined) throw new Error(`${entry} has no verb`);
  return verb;
}

/** The CLI's arguments for an entry: its verb with the input on stdin. */
const argvOf = (entry: string, input: Record<string, unknown>): string[] => [
  verbOf(entry, input),
  "--input",
  "-",
  "--json",
];

/** Whether the CLI has a command for an entry. A read only the page makes has none. */
const onCli = (entry: string): boolean =>
  entry === "entry.add" || CLI_SPEC.verbs.some((v) => v.entry === entry);

contractSuite("[A3.3.2.ops.contract] the contract suite, through the CLI with --json", async () => {
  const w = await contractWorld("cj");
  const transport: ContractTransport = {
    portal: w.portal,
    folder: (task) => w.folder(task),
    // The CLI holds no binding: `ttasks show --launch` resolves the reference for that call.
    // An entry with no command is the UI's alone.
    carries: onCli,
    launch: async (task) => (await w.launch(task)).reference,
    call: async (entry, input, actor) => {
      // An entry without a command goes the request path the CLI's own calls take.
      if (!onCli(entry)) {
        const session = await classSession(w.home, w.path, "cli-interactive");
        try {
          return await session.call("op/call", { op: entry, input }, { timeoutMs: 60_000 });
        } catch (error) {
          throw new ContractError(errorOf(error));
        } finally {
          session.close();
        }
      }
      const ran = await runMain(argvOf(entry, input), {
        home: w.home,
        tty: actor === "user",
        stdin: JSON.stringify(input),
      });
      const out = JSON.parse(ran.stdout) as Record<string, unknown>;
      // A result may hold an `error` of its own (a receipt of a refusal): exit 0 is a result.
      if (ran.code === 0) return out;
      const error = out["error"] as ErrorBody | undefined;
      if (error === undefined)
        throw new Error(`ttasks exited ${String(ran.code)} without an error`);
      // The CLI adds A2's class to A3's body; the suite compares A3's.
      throw new ContractError({
        code: error.code,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.data === undefined ? {} : { data: error.data }),
      });
    },
    close: () => w.close(),
  };
  return transport;
});

grantSuite(
  "the grant gate through the CLI with --json, for a call acting as a session of a revoked home",
  async () => {
    const w = await contractWorld("cg");
    const { ticket } = await revokedSession(w);
    return {
      refused: async (entry, input) => {
        const ran = await runMain([verbOf(entry, input), "--input", "-", "--json"], {
          home: w.home,
          env: { TTASKS_TICKET: ticket },
          stdin: JSON.stringify(input),
        });
        if (ran.code === 0) return undefined;
        expect(ran.code, entry).toBe(EXIT_CODES.forbidden);
        const error = (JSON.parse(ran.stdout) as { error?: ErrorBody & { class?: string } }).error;
        if (error === undefined)
          throw new Error(`ttasks exited ${String(ran.code)} without an error`);
        // The CLI adds A2's class to A3's body; the suite compares A3's.
        expect(error.class, entry).toBe("forbidden");
        return {
          code: error.code,
          message: error.message,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
          ...(error.data === undefined ? {} : { data: error.data }),
        };
      },
      close: () => w.close(),
    };
  },
);
