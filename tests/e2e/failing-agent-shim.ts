import "../../packages/bridge/src/safe-exit.ts";
import { startAgent } from "../../packages/cli/src/shim/agent.ts";
import { runShim } from "../../packages/cli/src/shim/run.ts";
import { failingAgentArgv } from "../../packages/testkit/src/failing-agent.ts";

process.exit(
  await runShim(process.argv.slice(3), {
    startAgent: ({ env }) => startAgent({ argv: failingAgentArgv, env }),
  }),
);
