// Binding through a real bridge process (A3 3.7.2, 3.7.3, 3.7.6 path A; A2 3.7.5; A7 3.9 M2.04): a
// terminal launch whose real shim starts a fake agent, and the bridge an agent app would start for
// it, `tasks mcp`, with the launch's ticket in its environment and nothing else of the launch. The
// bridge reads the ticket from its environment into its bind frame, and the service binds the
// connection before any tool call. Then the service restarts: the bridge reconnects with its
// binding handle, and the binding is the same. Fixture text and temporary folders only.
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

describe("[A3.3.7.binding.bridge-process] a launched agent's bridge binds by the ticket in its environment", () => {
  test(
    "bound at the bind frame, its write is the session's; after a service restart its handle resumes the same binding",
    { timeout: 300_000 },
    async () => {
      const lab = await ShimLab.create("bind-bridge");
      labs.push(lab);
      // The entry's agent home, registered for the space as setup does. The lab's service runs
      // without its UI listener, so its grants table is this start's own: it is registered again
      // after the restart below (a `tasks serve` keeps it in service.sqlite).
      const register = async () => {
        await grantHome(lab.home, lab.service?.endpoint.path ?? "", {
          instance: "fixture-agent",
          space: lab.spaceId,
        });
      };
      await register();
      const intent = await lab.launch(lab.plan());
      // The agent runs: its shim reported its start.
      await lab.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      const ticket = lab.tickets.get(intent.id);
      if (ticket === undefined) throw new Error("no ticket");

      // As the agent app starts it: the entry's arguments, the agent's environment with the ticket.
      const command = forwarderCommand([
        "--space",
        lab.spaceId,
        "--instance",
        "fixture-agent",
        "--app",
        "test",
      ]);
      const bridge = new Bridge(
        procs.spawn(
          command.file,
          command.args,
          cleanEnv({ TASKS_HOME: lab.home, TASKS_TICKET: ticket }),
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

      // The service restarts; the shim and the agent keep running, the bridge reconnects with its
      // handle and keeps its binding (its calls wait for the new service, A2 3.7.5).
      await lab.stopService();
      await lab.start();
      await register();
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
