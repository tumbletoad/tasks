// The crash test of the tree writer: a real child process (tree-child.ts) writes to a disposable
// tree space and is killed for real, before a COMMIT, after one, and by a timer, and each kill is
// followed by a round that sends the killed request again with its request ID, as a client whose
// reply was lost does. After every round the space must hold every result the child saw, no
// decision a kill took before its COMMIT, each request applied at most once, and every row exactly
// its history played back, with each commit's receipt.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { checkedDriver, tempFolders } from "../../packages/storage/test/space-helpers.ts";
import { openTree, treeHistoryProblems } from "../../packages/storage/test/tree-helpers.ts";
import type { TreeMessage, TreePlan, TreePlanned } from "./tree-child.ts";

const CHILD = fileURLToPath(new URL("./tree-child.ts", import.meta.url));
const ROUND_LIMIT_MS = 60_000;

const temp = tempFolders("tree-crash");
afterAll(temp.cleanup);

interface RoundEnd {
  messages: TreeMessage[];
  killed: boolean;
}

/** Runs one child with `plan`, killing it at its armed point or `afterMs` after its first send. */
async function round(plan: TreePlan, afterMs?: number): Promise<RoundEnd> {
  const child = spawn(process.execPath, [CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages: TreeMessage[] = [];
  let killed = false;
  const kill = (): void => {
    killed = child.kill("SIGKILL") || killed;
  };
  const watchdog = setTimeout(kill, ROUND_LIMIT_MS);
  let timer: NodeJS.Timeout | undefined;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as TreeMessage;
    messages.push(message);
    if (message.t === "at") kill();
    if (message.t === "send" && afterMs !== undefined) timer ??= setTimeout(kill, afterMs);
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(plan));
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(watchdog);
  clearTimeout(timer);
  return { messages, killed };
}

/** The requests of round `n`: adds, a finish with follow-ups, edits on fresh and stale bases. */
function requests(n: number): TreePlanned[] {
  const id = (k: number) => `r${String(n)}-${String(k)}`;
  const parent = `t_${String(n + 1).padStart(26, "0")}`;
  return [
    {
      request_id: id(1),
      agent: false,
      base: "none",
      command: "tasks.add",
      input: { tasks: [{ id: parent, title: `Round ${String(n)}` }] },
    },
    {
      request_id: id(2),
      agent: true,
      base: "fresh",
      command: "tasks.add",
      input: { tasks: [{ under: parent, title: "A part" }] },
    },
    {
      request_id: id(3),
      agent: false,
      base: "fresh",
      command: "task.update",
      input: { task: parent, set: { title: "Renamed", priority: 2 } },
    },
    {
      request_id: id(4),
      agent: true,
      base: "stale",
      command: "task.update",
      input: { task: parent, set: { title: "Stale" } },
    },
    {
      request_id: id(5),
      agent: false,
      base: "fresh",
      command: "task.finish",
      input: { task: parent, subtasks: "all", outcome: "Done", follow_ups: [{ title: "Next" }] },
    },
    { request_id: id(6), agent: false, base: "none", command: "undo", input: {} },
  ];
}

describe("[S2.tree.crash] the tree writer survives a kill at each write point and a lost reply", () => {
  test(
    "before and after a COMMIT and by a timer, each followed by a resend: nothing lost, nothing twice",
    { timeout: 300_000 },
    async () => {
      const checked = await checkedDriver();
      const folder = temp.make();
      openTree(checked, folder, true).close();
      const kills: (TreePlan["arm"] | number)[] = [
        { point: "before-commit", nth: 3 },
        { point: "after-commit", nth: 4 },
        5,
        null,
      ];
      const acked = new Map<string, { seq: number; commit?: string }>();
      let resend: TreePlanned | undefined;
      let resent = 0;
      for (const [n, kill] of kills.entries()) {
        const planned = [...(resend === undefined ? [] : [resend]), ...requests(n)];
        if (resend !== undefined) resent += 1;
        const arm = typeof kill === "number" ? null : kill;
        const end = await round(
          { folder, arm, requests: planned },
          typeof kill === "number" ? kill : undefined,
        );
        expect(end.messages.filter((m) => m.t === "error")).toEqual([]);
        const at = end.messages.find((m) => m.t === "at");
        for (const m of end.messages) {
          if (m.t === "ack" && m.status === "applied" && m.commit !== undefined) {
            acked.set(m.request_id, { seq: m.seq, commit: m.commit });
          }
        }
        const sent = end.messages
          .filter((m) => m.t === "send")
          .map((m) => (m as { request_id: string }).request_id);
        const answered = new Set(
          end.messages
            .filter((m) => m.t === "ack")
            .map((m) => (m as { request_id: string }).request_id),
        );
        const lost = sent.find((r) => !answered.has(r));
        resend = lost === undefined ? undefined : planned.find((p) => p.request_id === lost);

        const fx = openTree(checked, folder, false);
        const problems = treeHistoryProblems(fx.conn);
        const commit = (request: string) =>
          fx.conn
            .prepare("SELECT seq, id FROM commits WHERE request_id = $request")
            .all({ request });
        const receipt = (request: string) =>
          fx.conn.prepare("SELECT seq FROM receipts WHERE request_id = $request").get({ request });
        const kept = [...acked].filter(([request, a]) => {
          const rows = commit(request);
          return rows.length === 1 && rows[0]?.["seq"] === a.seq && rows[0]["id"] === a.commit;
        }).length;
        const twice = fx.conn
          .prepare(
            "SELECT count(*) AS n FROM (SELECT request_id FROM commits GROUP BY request_id HAVING count(*) > 1)",
          )
          .get()?.["n"];
        const before =
          at?.t === "at" && at.point === "before-commit" ? receipt(at.request_id) : undefined;
        const afterCommit =
          at?.t === "at" && at.point === "after-commit" && at.status === "applied"
            ? commit(at.request_id).length
            : 1;
        fx.close();
        expect(problems).toEqual([]);
        expect(kept).toBe(acked.size);
        expect(twice).toBe(0);
        expect(before).toBeUndefined();
        expect(afterCommit).toBe(1);
        if (kill !== null) expect(end.killed).toBe(true);
      }
      expect(acked.size).toBeGreaterThan(10);
      expect(resent).toBeGreaterThanOrEqual(2);
    },
  );
});
