// The expanded task's detail on the real service: the request a session names is in the thread
// whole, whatever the task holds after it.
import { afterEach, describe, expect, test } from "vitest";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { httpWorld, type HttpWorld } from "@ttasks/service/test/http-world";
import { readDetail } from "../src/task/detail.ts";

const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

let requests = 0;
const id = () => `detail-request-${String((requests += 1)).padStart(4, "0")}`;

describe("[A5.3.9.web.thread-request] the request a session names is in the detail whatever the task holds", () => {
  test(
    "a request behind long notes and instructions comes whole, of either kind, and the pages stay as many",
    { timeout: 180_000 },
    async () => {
      const w = await httpWorld("detail-request");
      worlds.push(w);
      const user = await w.user();
      let reads = 0;
      const call = (op: string, input: Record<string, unknown>) =>
        user.call("op/call", { op, input }, { timeoutMs: 60_000 });
      const client = {
        task: {
          get: (input: Record<string, unknown>) => {
            reads += 1;
            return call("task.get", input);
          },
        },
      } as unknown as Client;
      const added = (await call("task.add", {
        tasks: [{ title: "A task with a long thread" }],
        request_id: id(),
      })) as { tasks: { ref: string }[] };
      const task = added.tasks[0]?.ref ?? "";
      const note = async (text: string, forAgents = false) =>
        (
          (await call("entry.add", {
            task,
            kind: "note",
            text,
            ...(forAgents ? { for_agents: true } : {}),
            request_id: id(),
          })) as { entry: string }
        ).entry;
      const joiner = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
      const asked = `Fix the offset ${joiner}\n${"a".repeat(10_000)}`;
      const instruction = `Keep the export ${joiner}\n${"b".repeat(5_000)}`;
      const request = await note(asked);
      const toAgents = await note(instruction, true);
      for (const fill of ["c", "d"]) await note(fill.repeat(42_000));
      for (const fill of ["e", "f"]) await note(fill.repeat(42_000), true);

      const { detail: before } = await readDetail(client, task);
      const paged = reads;
      expect(before.partial).toBe(true);
      reads = 0;
      const { detail } = await readDetail(client, task, [request, toAgents]);
      expect(detail.notes.find((n) => n.ref === request)?.text).toBe(asked);
      expect(detail.notes.find((n) => n.ref === toAgents)).toMatchObject({
        text: instruction,
        forAgents: true,
      });
      expect(new Set(detail.notes.map((n) => n.ref)).size).toBe(detail.notes.length);
      // The named notes come with the digest: no page more is read for them.
      expect(reads).toBe(paged);
    },
  );
});
