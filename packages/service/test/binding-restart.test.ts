// A launched agent across a restart of its service whose launch file another program holds as the
// service reads it (a virus scanner on Windows): the service in this process over a real shim and
// fake agent (shim-harness.ts), and the agent's connections made as a bridge and a shell make them
// (agents.ts). The waits between the tries are the test's, so nothing sleeps. Fixture text and
// temporary folders only.
import { join } from "node:path";
import { newTicket } from "@ttasks/launch";
import { CAN_HOLD_FILES, holdFile } from "@ttasks/testkit";
import { afterEach, describe, expect, test } from "vitest";
import { namedBy } from "../src/hub/named.ts";
import type { LiveRun } from "../src/runs/service.ts";
import { bridge, launchContext, shell, written } from "./agents.ts";
import { readLog } from "./harness.ts";
import { bridgeContext } from "./mcp-helpers.ts";
import { grantHome } from "./ops-helpers.ts";
import { ShimLab } from "./shim-harness.ts";

const labs: ShimLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.cleanup();
}, 120_000);

/** A lab with one launched agent registered as `fixture-agent`, and its connections' world. */
async function launched(label: string) {
  // Its grants in service.sqlite, as an install keeps them across a restart.
  const lab = await ShimLab.create(label, { http: true });
  labs.push(lab);
  await grantHome(lab.home, lab.running.endpoint.path, {
    instance: "fixture-agent",
    space: lab.spaceId,
  });
  const intent = await lab.launch(lab.plan());
  await lab.waitIntent(intent.id, (i) => i.evidence.pid !== undefined, "the agent's start");
  const ticket = lab.tickets.get(intent.id) ?? "";
  const served = () => ({ service: lab.running, home: lab.home, path: lab.running.endpoint.path });
  const context = launchContext(lab.spaceId, { instance: "fixture-agent", app: "codex", ticket });
  const file = join(lab.running.runtime.launch, intent.id, "launch.json");
  return { lab, intent, ticket, served, context, file };
}

const unreadableEvents = (home: string) =>
  readLog(home).filter((line) => line["ev"] === "launch.file_unreadable");

describe.skipIf(!CAN_HOLD_FILES)(
  "[A3.3.7.binding.ticket] a launch file held as its service starts again",
  () => {
    test(
      "held for a moment: it is read at a later try, the agent's next bind is the same session, and its retried note is applied once",
      { timeout: 300_000 },
      async () => {
        const { lab, intent, ticket, served, context, file } = await launched("bind-held");
        const first = await bridge(served(), context);
        expect(first.binding).toEqual({ space: lab.spaceId, state: "bound" });
        const input = {
          kind: "note",
          task: lab.taskId,
          text: "Fixture note sent across a restart.",
          request_id: "fixture-held-0000000001",
        };
        await first.call("entry.add", input);
        await first.close();

        // The service stops; as it starts again its launch file is held, and let go at the
        // second wait.
        await lab.stopService();
        const hold = holdFile(file);
        let waits = 0;
        try {
          await lab.start({
            recordsWait: () => {
              waits += 1;
              if (waits === 2) hold.release();
            },
          });
        } finally {
          hold.release();
        }
        expect(waits).toBe(2);
        expect(unreadableEvents(lab.home)).toEqual([]);

        // The same bridge process reconnects with its ticket and the space it holds: the same
        // session, and the retry its lost reply made replays, from the bridge and the shell alike.
        const again = await bridge(served(), { ...context, held_space: lab.spaceId });
        expect(again.binding).toEqual({ space: lab.spaceId, state: "bound" });
        expect(await again.call("entry.add", input)).toContain("(replayed)");
        const sh = await shell(served(), { TTASKS_TICKET: ticket });
        expect(await sh.call("entry.add", input, { space: lab.spaceId })).toMatchObject({
          replayed: true,
        });
        expect(
          (await written(served(), lab.spaceId, input.request_id)).map((r) => r.scope),
        ).toEqual([`session:se_${intent.id.slice("la_".length)}`]);
        await again.close();
        await sh.close();
      },
    );

    test(
      "held through every wait: it is left out with one log event, the service starts, and a chat started by hand and a run's ticket work",
      { timeout: 300_000 },
      async () => {
        const { lab, intent, ticket, served, context, file } = await launched("bind-stuck");
        await lab.stopService();
        const hold = holdFile(file);
        try {
          await lab.start({ recordsWait: () => undefined });
        } finally {
          hold.release();
        }
        // One event, naming the launch and the error's code: no path, no content.
        const events = unreadableEvents(lab.home);
        expect(events).toHaveLength(1);
        expect(events[0]?.["launch"]).toBe(intent.id);
        expect(typeof events[0]?.["code"]).toBe("string");
        expect(JSON.stringify(events[0])).not.toContain(lab.root);

        // The records in memory decide from here: the launch left out is no launch, at once.
        const bridged = await bridge(served(), context);
        expect(bridged.binding).toEqual({ space: lab.spaceId, state: "unbound" });
        await bridged.close();
        const sh = await shell(served(), { TTASKS_TICKET: ticket });
        const note = {
          kind: "note",
          task: lab.taskId,
          text: "Fixture note from the agent's shell.",
          request_id: "fixture-stuck-000000002",
        };
        expect(await sh.call("entry.add", note, { space: lab.spaceId })).toMatchObject({
          result: "logged",
        });
        await sh.close();

        // A chat started by hand with the entry setup wrote works in its space.
        const chat = await bridge(
          served(),
          bridgeContext({ instance: "fixture-agent", app: "codex" }),
        );
        expect(chat.binding).toEqual({ space: lab.spaceId, state: "unbound" });
        await chat.call("entry.add", {
          kind: "note",
          task: lab.taskId,
          text: "Fixture note from a chat started by hand.",
          request_id: "fixture-stuck-000000001",
        });
        await chat.close();

        // A background run's ticket is looked up past the launches, which name nothing for it.
        const run: LiveRun = {
          run: "ru_00000000000000000000000003",
          space: lab.spaceId,
          task: lab.taskId,
          instance: "fixture-runner",
          session: "se_00000000000000000000000003",
        };
        const runTicket = newTicket();
        const named = namedBy(
          {
            launches: () => lab.running.launches.host,
            runs: { liveByTicket: (value) => (value === runTicket ? run : undefined) },
          },
          { ticket: runTicket },
        );
        expect(named).toEqual({ kind: "one", by: "ticket", live: { of: "run", ...run } });
      },
    );
  },
);
