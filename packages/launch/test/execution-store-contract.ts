// The execution store's contract suite: every backend of the interface must pass
// it, so the state machine, which knows only the interface, behaves the same on each. v1 runs it
// against the in-memory backend and the space database's (space-store.ts, in-thread and through
// the storage worker). The L1 journal must pass it too.
//
// It covers what the machine relies on: one record per click and request ID, replay of a request
// ID, a compare-and-set that moves nothing when it loses, only the machine's edges, evidence that only grows,
// a timestamp per state, openWork per machine after a restart, and records without free text.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EDGES, INTENT_STATES, isLaunchRef, type IntentState } from "../src/intents.ts";
import {
  ExecutionRefused,
  LAUNCH_ID,
  type ExecutionStore,
  type LaunchIntent,
  type NewIntent,
  type Outcome,
} from "../src/store.ts";

/** One backend under test, on fresh durable state. */
export interface ContractBackend {
  store: ExecutionStore;
  /** The machine this backend writes for. */
  machine: string;
  /** A task this backend accepts (a task of the space, for the space database). */
  task(): Promise<string>;
  /** A place of `machine` this backend accepts. */
  place(): Promise<string>;
  /** Moves the backend's clock: forward, or back for a negative `ms`. */
  advance(ms: number): void;
  /** Drops the store as a crash would and returns a new one on the same durable state. */
  restart(): Promise<ExecutionStore>;
  close(): Promise<void>;
}

const HASH = "9f2c41d7".repeat(8);
const OTHER_MACHINE = "m_0000000000000000000000000z";

/** A path through the launch machine from Prepared to `state`, with the reasons each step needs. */
const PATHS: Record<IntentState, { next: IntentState; outcome?: Outcome }[]> = {
  prepared: [],
  dispatching: [{ next: "dispatching" }],
  dispatched: [{ next: "dispatching" }, { next: "dispatched" }],
  confirmed: [{ next: "dispatching" }, { next: "dispatched" }, { next: "confirmed" }],
  failed: [{ next: "failed", outcome: { reason: "cancelled" } }],
  unknown: [{ next: "dispatching" }, { next: "unknown", outcome: { reason: "no_answer" } }],
};

/** The outcome a transition into `next` needs. */
function outcomeFor(from: IntentState, next: IntentState): Outcome {
  if (from === next) return { evidence: { pid: 4242 } };
  if (next === "failed") return { reason: from === "prepared" ? "cancelled" : "refused" };
  if (next === "unknown") return { reason: from === "dispatched" ? "lost" : "no_answer" };
  return {};
}

let requests = 0;
const requestId = (): string => `contract-request-${String((requests += 1)).padStart(8, "0")}`;

async function refusal(promise: Promise<unknown>): Promise<ExecutionRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExecutionRefused) return error;
    throw error;
  }
  throw new Error("The call was not refused");
}

/** Every string a record holds: IDs, codes and states only (AGENTS.md). */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

export function executionStoreContract(
  name: string,
  open: () => Promise<ContractBackend>,
  timeout = 60_000,
): void {
  describe(`[A4.5.execution-store.contract] the ExecutionStore contract: ${name}`, () => {
    let backend: ContractBackend;
    let store: ExecutionStore;

    beforeEach(async () => {
      backend = await open();
      store = backend.store;
    }, timeout);

    afterEach(async () => {
      await backend.close();
    }, timeout);

    const intentInput = async (extra: Partial<NewIntent> = {}): Promise<NewIntent> => ({
      task: await backend.task(),
      machine: backend.machine,
      instance: "codex-work",
      route: "terminal",
      place: null,
      taskVersion: 3,
      briefHash: HASH,
      ...extra,
    });

    /** A fresh intent moved along the launch machine to `state`. */
    const intentIn = async (state: IntentState, extra: Partial<NewIntent> = {}) => {
      let intent = await store.createIntent(await intentInput(extra), requestId());
      for (const step of PATHS[state]) {
        intent = await store.transitionIntent(intent.id, intent.state, step.next, step.outcome);
      }
      return intent;
    };

    test("a click records one Prepared intent with the click's IDs and nothing else", async () => {
      const place = await backend.place();
      const input = await intentInput({
        place,
        route: "t3-mcp",
        evidence: { folder_id: "2049:131077", preset: "0a6f1f0e-7d1c-4c55-9f43-2b8e4f6d2a10" },
      });
      const intent = await store.createIntent(input, requestId());
      expect(intent).toMatchObject({
        task: input.task,
        session: null,
        machine: backend.machine,
        instance: "codex-work",
        route: "t3-mcp",
        place,
        folderKind: "place",
        taskVersion: 3,
        briefHash: HASH,
        state: "prepared",
        reason: null,
        evidence: input.evidence,
      });
      expect(intent.id).toMatch(LAUNCH_ID);
      expect(isLaunchRef(intent.reference)).toBe(true);
      expect(intent.at).toEqual({ prepared: intent.createdAt });
      expect(intent.updatedAt).toBe(intent.createdAt);
      expect(await store.readIntent(intent.id)).toEqual(intent);
      const workFolder = await store.createIntent(
        await intentInput({ instance: "claude-work" }),
        requestId(),
      );
      expect(workFolder.folderKind).toBe("work_folder");
      expect(workFolder.place).toBeNull();
      expect(workFolder.reference).not.toBe(intent.reference);
    });

    test("every string in a record is an ID, a code or a state", async () => {
      const intent = await intentIn("dispatched", { evidence: { folder_id: "2049:131077" } });
      const claimed = await store.transitionIntent(intent.id, "dispatched", "dispatched", {
        evidence: { claim: "c1a1m", claimed_at: intent.createdAt, folder_checked: true },
      });
      for (const text of strings(claimed)) expect(text).toMatch(/^[A-Za-z0-9_.:-]+$/);
    });

    test("the same request ID returns the same intent; another input under it is refused", async () => {
      const input = await intentInput();
      const id = requestId();
      const first = await store.createIntent(input, id);
      await store.transitionIntent(first.id, "prepared", "dispatching");
      const again = await store.createIntent({ ...input }, id);
      expect(again.id).toBe(first.id);
      expect(again.state).toBe("dispatching");
      const restarted = await backend.restart();
      store = restarted;
      expect((await restarted.createIntent(input, id)).id).toBe(first.id);
      const reused = await refusal(restarted.createIntent({ ...input, taskVersion: 4 }, id));
      expect(reused.code).toBe("request_id_reused");
      expect((await restarted.openWork(backend.machine)).intents.map((i) => i.id)).toEqual([
        first.id,
      ]);
    });

    test("a click with text, a bad ID or a bad hash is refused and records nothing", async () => {
      const input = await intentInput();
      const bad: unknown[] = [
        { ...input, task: "M-14" },
        { ...input, route: "carrier-pigeon" },
        { ...input, briefHash: "ABC" },
        { ...input, instance: "Codex · work" },
        { ...input, place: "/home/mira/work" },
        { ...input, evidence: { title: "Fix appointment time zones" } },
        { ...input, evidence: { thread: "Fix appointment time zones" } },
        { ...input, brief: "Read the task, then wait for my instructions" },
      ];
      for (const value of bad) {
        const refused = await refusal(store.createIntent(value as NewIntent, requestId()));
        expect(refused.code).toBe("invalid");
        expect(refused.message).not.toContain("Fix appointment");
      }
      expect((await store.openWork(backend.machine)).intents).toEqual([]);
    });

    test("a second click on the same task and instance gets the intent still opening, and only that one", async () => {
      const input = await intentInput();
      const first = await store.createIntent(input, requestId());
      expect((await store.createIntent(input, requestId())).id).toBe(first.id);
      expect(
        (await store.createIntent({ ...input, instance: "claude-work" }, requestId())).id,
      ).not.toBe(first.id);
      await store.transitionIntent(first.id, "prepared", "dispatching");
      // However long it takes, and whatever the clock did meanwhile.
      backend.advance(600_000);
      expect((await store.createIntent(input, requestId())).id).toBe(first.id);
      backend.advance(-3_600_000);
      await store.transitionIntent(first.id, "dispatching", "dispatched");
      expect((await store.createIntent(input, requestId())).id).toBe(first.id);
      // Once its shim settled it, a click at once is a new launch: the session it opens is new.
      await store.transitionIntent(first.id, "dispatched", "confirmed");
      const next = await store.createIntent(input, requestId());
      expect(next.id).not.toBe(first.id);
      expect(next.state).toBe("prepared");
      await store.transitionIntent(next.id, "prepared", "failed", { reason: "cancelled" });
      expect((await store.createIntent(input, requestId())).id).not.toBe(next.id);
    });

    test("a click that continues a conversation joins only a launch still opening that continues the same one", async () => {
      const input = await intentInput();
      const continues = (id: string) => ({ ...input, evidence: { resumes: id } });
      const opening = await store.createIntent(input, requestId());
      const first = await store.createIntent(continues("conversation-a"), requestId());
      expect(first.id).not.toBe(opening.id);
      expect((await store.createIntent(continues("conversation-a"), requestId())).id).toBe(
        first.id,
      );
      const second = await store.createIntent(continues("conversation-b"), requestId());
      expect([opening.id, first.id]).not.toContain(second.id);
      // An Open that continues nothing still joins the one that continues nothing.
      expect((await store.createIntent(input, requestId())).id).toBe(opening.id);
    });

    test("a link or T3 launch that asked its app holds no click", async () => {
      for (const route of ["link", "t3-mcp"] as const) {
        const input = await intentInput({ route });
        const asked = await store.createIntent(input, requestId());
        await store.transitionIntent(asked.id, "prepared", "dispatching");
        await store.transitionIntent(asked.id, "dispatching", "dispatched");
        const next = await store.createIntent(input, requestId());
        expect(next.id, route).not.toBe(asked.id);
      }
    });

    test("every edge of A4's machine moves, records its time, and no other edge does", async () => {
      for (const from of INTENT_STATES) {
        for (const to of INTENT_STATES) {
          const intent = await intentIn(from, { instance: `edge-${from}-${to}` });
          backend.advance(10_000);
          const legal = EDGES[from].includes(to);
          const call = store.transitionIntent(intent.id, from, to, outcomeFor(from, to));
          if (!legal) {
            const refused = await refusal(call);
            expect(refused.code, `${from} -> ${to}`).toBe("invalid");
            expect(await store.readIntent(intent.id)).toEqual(intent);
            continue;
          }
          const after = await call;
          expect(after.state, `${from} -> ${to}`).toBe(to);
          // What a transition returns is what it wrote, and what a read finds after it.
          expect(await store.readIntent(intent.id), `${from} -> ${to} read back`).toEqual(after);
          expect(after.version).toBeGreaterThan(intent.version);
          expect(after.updatedAt).toBeGreaterThan(intent.updatedAt);
          if (from === to) {
            expect(after.at).toEqual(intent.at);
            expect(after.evidence.pid).toBe(4242);
          } else {
            expect(after.at).toEqual({ ...intent.at, [to]: after.updatedAt });
            expect(after.reason).toBe(outcomeFor(from, to).reason ?? null);
          }
        }
      }
    });

    test("a transition from a state the record has left is stale and moves nothing", async () => {
      const intent = await intentIn("dispatched");
      const stale = await refusal(store.transitionIntent(intent.id, "dispatching", "dispatched"));
      expect(stale.code).toBe("stale");
      expect(stale.current).toEqual(intent);
      expect(await store.readIntent(intent.id)).toEqual(intent);
      const missing = await refusal(
        store.transitionIntent("la_0000000000000000000000000a", "prepared", "dispatching"),
      );
      expect(missing.code).toBe("not_found");
    });

    test("a transition on the version it read is stale once the record changed, a self edge too", async () => {
      const intent = await intentIn("dispatched");
      const read = { state: intent.state, version: intent.version };
      const claimed = await store.transitionIntent(intent.id, read, "dispatched", {
        evidence: { claim: "claim-one", claimed_at: intent.createdAt },
      });
      // A path that decided on the record before the claim: a sweep, or the same claim again.
      for (const [next, outcome] of [
        ["failed", { reason: "not_claimed" }],
        ["dispatched", { evidence: { claim: "claim-one", claimed_at: intent.createdAt } }],
        ["dispatched", { evidence: { pid: 4242 } }],
      ] as [IntentState, Outcome][]) {
        const stale = await refusal(store.transitionIntent(intent.id, read, next, outcome));
        expect(stale.code, next).toBe("stale");
        expect(stale.current).toEqual(claimed);
      }
      expect(await store.readIntent(intent.id)).toEqual(claimed);
      const now = { state: claimed.state, version: claimed.version };
      const lost = await store.transitionIntent(intent.id, now, "unknown", { reason: "lost" });
      expect(lost).toMatchObject({
        state: "unknown",
        reason: "lost",
        evidence: { claim: "claim-one" },
      });
      const malformed = await refusal(
        store.transitionIntent(lost.id, { state: "unknown", version: -1 }, "failed", {
          reason: "refused",
        }),
      );
      expect(malformed.code).toBe("invalid");
    });

    test("every record reads back unchanged after a restart, final ones too", async () => {
      const all: LaunchIntent[] = [];
      for (const [i, state] of INTENT_STATES.entries()) {
        all.push(
          await intentIn(state, {
            instance: `restart-${String(i)}`,
            evidence: { folder_id: `2049:13107${String(i)}` },
          }),
        );
      }
      const dispatched = all[2];
      if (dispatched === undefined) throw new Error("no dispatched intent");
      all[2] = await store.transitionIntent(dispatched.id, "dispatched", "dispatched", {
        evidence: { claim: "claim-r", pid: 77 },
      });
      const restarted = await backend.restart();
      store = restarted;
      for (const intent of all) {
        expect(await restarted.readIntent(intent.id), intent.state).toEqual(intent);
      }
    });

    test("two paths racing from one state: exactly one moves the record", async () => {
      const intent = await intentIn("dispatching");
      const [live, recovery] = await Promise.allSettled([
        store.transitionIntent(intent.id, "dispatching", "dispatched"),
        store.transitionIntent(intent.id, "dispatching", "unknown", { reason: "lost" }),
      ]);
      const won = [live, recovery].filter((r) => r.status === "fulfilled");
      const lost = [live, recovery].filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason: unknown = lost[0]?.status === "rejected" ? lost[0].reason : undefined;
      expect(reason).toBeInstanceOf(ExecutionRefused);
      expect((reason as ExecutionRefused).code).toBe("stale");
      const now = await store.readIntent(intent.id);
      expect(now?.state).toBe(won[0]?.status === "fulfilled" ? won[0].value.state : undefined);
    });

    test("Failed and Unknown need a reason code of their own, and no other state takes one", async () => {
      const prepared = await intentIn("prepared");
      for (const [next, outcome] of [
        ["failed", {}],
        ["failed", { reason: "lost" }],
        ["dispatching", { reason: "expired" }],
      ] as [IntentState, Outcome][]) {
        const refused = await refusal(
          store.transitionIntent(prepared.id, "prepared", next, outcome),
        );
        expect(refused.code).toBe("invalid");
        expect(refused.field).toBe("reason");
      }
      const dispatching = await intentIn("dispatching", { instance: "t3-work" });
      const refused = await refusal(
        store.transitionIntent(dispatching.id, "dispatching", "unknown", { reason: "expired" }),
      );
      expect(refused.field).toBe("reason");
      expect(await store.readIntent(prepared.id)).toEqual(prepared);
    });

    test("evidence only grows: a claim is recorded once and never rewritten", async () => {
      const intent = await intentIn("dispatched");
      const claimed = await store.transitionIntent(intent.id, "dispatched", "dispatched", {
        evidence: { claim: "claim-one", claimed_at: 1_800_000_000_000 },
      });
      expect(claimed.evidence).toMatchObject({ claim: "claim-one", claimed_at: 1_800_000_000_000 });
      expect(claimed.state).toBe("dispatched");
      const second = await refusal(
        store.transitionIntent(intent.id, "dispatched", "dispatched", {
          evidence: { claim: "claim-two" },
        }),
      );
      expect(second.code).toBe("evidence");
      expect(second.field).toBe("evidence.claim");
      expect(second.current).toEqual(claimed);
      const same = await store.transitionIntent(intent.id, "dispatched", "dispatched", {
        evidence: { claim: "claim-one" },
      });
      expect(same).toEqual(claimed);
      const empty = await refusal(store.transitionIntent(intent.id, "dispatched", "dispatched"));
      expect(empty.code).toBe("invalid");
      const confirmed = await store.transitionIntent(intent.id, "dispatched", "confirmed", {
        evidence: { pid: 31337, pid_started_at: 1_800_000_000_500 },
      });
      expect(confirmed.evidence).toMatchObject({ claim: "claim-one", pid: 31337 });
      const bad = await refusal(
        store.transitionIntent(intent.id, "confirmed", "confirmed", {
          evidence: { bound_at: -1 },
        }),
      );
      expect(bad.code).toBe("invalid");
      expect(bad.field).toBe("evidence.bound_at");
    });

    test("openWork lists this machine's open intents, the same after a restart", async () => {
      const open = await Promise.all(
        (["prepared", "dispatching", "dispatched"] as const).map((s, i) =>
          intentIn(s, { instance: `open-${String(i)}` }),
        ),
      );
      for (const [i, state] of (["confirmed", "failed", "unknown"] as const).entries()) {
        await intentIn(state, { instance: `closed-${String(i)}` });
      }
      const ids = (work: { intents: LaunchIntent[] }) => work.intents.map((x) => x.id).sort();
      const expected = open.map((x) => x.id).sort();
      expect(ids(await store.openWork(backend.machine))).toEqual(expected);
      expect((await store.openWork(OTHER_MACHINE)).intents).toEqual([]);
      const restarted = await backend.restart();
      store = restarted;
      const after = await restarted.openWork(backend.machine);
      expect(ids(after)).toEqual(expected);
      for (const intent of after.intents) {
        expect(intent).toEqual(open.find((x) => x.id === intent.id));
      }
    });
  });
}
