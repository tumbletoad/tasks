// A launched agent's session through a real bridge process: a terminal launch whose real shim
// starts a fake agent, and the bridge an agent app would start for it, `ttasks mcp`, with the
// launch's ticket in its environment and nothing else of the launch. The bridge reads the ticket
// from its environment into its bind frame, and the service decides at the bind that the
// connection is the launch's session. Then the service restarts: the bridge binds again with the
// ticket and the space it holds, and it is the same session, from the launch's record. Fixture
// text and temporary folders only.
import { afterEach, describe, expect, test } from "vitest";
import { grantHome } from "../../packages/service/test/ops-helpers.ts";
import { ShimLab } from "../../packages/service/test/shim-harness.ts";
import { Bridge, Procs, cleanEnv, forwarderCommand, textOf } from "./harness.ts";

const procs = new Procs();
const labs: ShimLab[] = [];
afterEach(async () => {
  await procs.stopAll();
  for (const lab of labs.splice(0)) await lab.cleanup();
});

const reply = async (bridge: Bridge, name: string, args: Record<string, unknown> = {}) =>
  textOf(await bridge.call(name, args)) ?? "";

describe("[A3.3.7.binding.bridge-process] a launched agent's bridge is its session by the ticket in its environment", () => {
  test(
    "its session from the bind frame, its write the session's; after a service restart the same session, and a retry replays",
    { timeout: 300_000 },
    async () => {
      // With its UI listener, so its grants table is service.sqlite's, as an install's is: the
      // registration is there again the moment the service listens after its restart.
      const lab = await ShimLab.create("bind-bridge", { http: true });
      labs.push(lab);
      // The entry's agent home, registered for the space as setup does.
      await grantHome(lab.home, lab.service?.endpoint.path ?? "", {
        instance: "fixture-agent",
        space: lab.spaceId,
      });
      const intent = await lab.launch(lab.plan());
      // The agent runs: its shim reported its start.
      await lab.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      const ticket = lab.tickets.get(intent.id);
      if (ticket === undefined) throw new Error("no ticket");

      // As the agent app starts it: the entry setup wrote for the launch's home, and the agent's
      // environment with the ticket.
      const command = forwarderCommand([
        "--space",
        lab.spaceId,
        "--instance",
        "fixture-agent",
        "--app",
        "codex",
      ]);
      const bridge = new Bridge(
        procs.spawn(
          command.file,
          command.args,
          cleanEnv({ TTASKS_HOME: lab.home, TTASKS_TICKET: ticket }),
        ),
      );
      await bridge.initialize();
      expect(await reply(bridge, "status")).toContain("Session: bound to M-1");
      const logged = await reply(bridge, "add_entry", {
        kind: "progress",
        text: "Fixture progress from the launched agent.",
        request_id: "fixture-bridge-binding-000001",
      });
      expect(logged).toContain("M-1");

      // The service restarts; the shim and the agent keep running, and the bridge reconnects (its
      // calls wait for the new service, A2 3.7.5): the same session.
      await lab.stopService();
      await lab.start();
      const after = await reply(bridge, "status");
      expect(after).toContain("Session: bound to M-1");
      // A retry of the first write after the restart replays it: the same session's scope.
      expect(
        await reply(bridge, "add_entry", {
          kind: "progress",
          text: "Fixture progress from the launched agent.",
          request_id: "fixture-bridge-binding-000001",
        }),
      ).toContain("replayed");
      expect(bridge.stray).toEqual([]);
      bridge.end();
    },
  );
});
