// A launched agent across a restart of its service whose launch file cannot be read for a moment
// (another program holds it, as a virus scanner does on Windows): the service in this process over
// a real shim and fake agent (shim-harness.ts), and the agent's connections made as a bridge and a
// shell make them (agents.ts). Fixture text and temporary folders only.
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bridge, launchContext, shell, written } from "./agents.ts";
import { grantHome } from "./ops-helpers.ts";
import { ShimLab } from "./shim-harness.ts";

const labs: ShimLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

describe("[A3.3.7.binding.ticket] a launch file that cannot be read at a restart decides nothing", () => {
  test(
    "the bridge's bind fails and the shell's call is refused, both to try again; once the file can be read, the same session, and the retried note is written once",
    { timeout: 300_000 },
    async () => {
      // Its grants in service.sqlite, as an install keeps them across a restart.
      const lab = await ShimLab.create("bind-unreadable", { http: true });
      labs.push(lab);
      await grantHome(lab.home, lab.running.endpoint.path, {
        instance: "fixture-agent",
        space: lab.spaceId,
      });
      const intent = await lab.launch(lab.plan());
      await lab.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
      const ticket = lab.tickets.get(intent.id) ?? "";
      const served = () => ({
        service: lab.running,
        home: lab.home,
        path: lab.running.endpoint.path,
      });
      const context = launchContext(lab.spaceId, {
        instance: "fixture-agent",
        app: "codex",
        ticket,
      });
      const first = await bridge(served(), context);
      expect(first.binding).toEqual({ space: lab.spaceId, state: "bound" });
      const input = {
        kind: "note",
        text: "Fixture note sent across a restart.",
        request_id: "fixture-unreadable-000001",
      };
      await first.call("entry.add", input);
      await first.close();

      // The service stops; as it starts again its launch file is held.
      const file = join(lab.running.runtime.launch, intent.id, "launch.json");
      await lab.stopService();
      renameSync(file, `${file}.kept`);
      mkdirSync(file);
      await lab.start();
      // The same bridge process reconnects with its ticket and the space it holds.
      const held = { ...context, held_space: lab.spaceId };
      await expect(bridge(served(), held)).rejects.toThrow();
      const sh = await shell(served(), { TTASKS_TICKET: ticket });
      const refused = await sh.refusal("entry.add", input, { space: lab.spaceId });
      expect(refused.body).toMatchObject({
        code: "service_unavailable",
        data: { reason: "not_ready", retryable: true },
      });

      // The file can be read again: the next bind is the session, and the retry replays.
      rmSync(file, { recursive: true });
      renameSync(`${file}.kept`, file);
      const again = await bridge(served(), held);
      expect(again.binding).toEqual({ space: lab.spaceId, state: "bound" });
      expect(await again.call("entry.add", input)).toContain("(replayed)");
      expect(await sh.call("entry.add", input, { space: lab.spaceId })).toMatchObject({
        replayed: true,
      });
      expect((await written(served(), lab.spaceId, input.request_id)).map((r) => r.scope)).toEqual([
        `session:se_${intent.id.slice("la_".length)}`,
      ]);
      await again.close();
      await sh.close();
    },
  );
});
