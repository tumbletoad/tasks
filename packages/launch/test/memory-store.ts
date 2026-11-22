// An execution store in memory, for tests: the reference backend of the contract suite. Its durable
// state is a separate object, so a test can drop a store (a crash) and build another on the same
// state (a restart). Each call is atomic because it runs synchronously between two awaits, and it
// stores copies, so no caller can change a record except through a call.
import {
  evidenceConflicts,
  isOpening,
  REF_ALPHABET,
  launchRefCheck,
  OPEN_STATES,
  type Evidence,
  type IntentState,
} from "../src/intents.ts";
import {
  FINAL_RUN_STATES,
  isOpenRun,
  type NewRun,
  type RunPatch,
  type RunRecord,
  type RunState,
} from "@ttasks/contracts/runs";
import {
  checkNewIntent,
  checkNewRun,
  checkRunTransition,
  checkTransition,
  ExecutionRefused,
  RunRefused,
  type ExecutionStore,
  type Expected,
  type LaunchIntent,
  type NewIntent,
  type Outcome,
  type RunExpected,
} from "../src/store.ts";

/** What survives a crash: the records, the receipts and the clock. */
export class MemoryDurable {
  readonly intents = new Map<string, LaunchIntent>();
  /** Request ID → the intent's ID and the input's fingerprint. */
  readonly receipts = new Map<string, { id: string; fingerprint: string }>();
  /** Every committed transition, in order, for invariant checks. */
  readonly history: { id: string; from: IntentState | null; to: IntentState }[] = [];
  readonly runs = new Map<string, RunRecord>();
  /** Request ID → the run's ID and the input's fingerprint. */
  readonly runReceipts = new Map<string, { id: string; fingerprint: string }>();
  /** Every committed run transition, in order, for invariant checks. */
  readonly runHistory: { id: string; from: RunState | null; to: RunState; version: number }[] = [];
  now: () => number;
  #seq = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The next record version. */
  tick(): number {
    this.#seq += 1;
    return this.#seq;
  }
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** An A1 ID: the prefix and 26 characters for 128 random bits (the first is 0 to 7). */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(26);
  globalThis.crypto.getRandomValues(bytes);
  let body = ID_ALPHABET.charAt((bytes[0] ?? 0) % 8);
  for (let i = 1; i < 26; i += 1) body += ID_ALPHABET.charAt((bytes[i] ?? 0) % 32);
  return `${prefix}_${body}`;
}

function randomReference(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const symbols = Array.from(bytes, (b) => REF_ALPHABET.charAt(b % 32)).join("");
  return `L${symbols}${launchRefCheck(symbols) ?? ""}`;
}

/** The fingerprint of a click's or a run's input: its JSON with the keys in order. */
function fingerprint(input: NewIntent | NewRun): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
}

const copy = (intent: LaunchIntent): LaunchIntent => structuredClone(intent);

export class MemoryExecutionStore implements ExecutionStore {
  readonly durable: MemoryDurable;

  constructor(durable: MemoryDurable = new MemoryDurable()) {
    this.durable = durable;
  }

  createIntent(input: NewIntent, requestId: string): Promise<LaunchIntent> {
    return Promise.resolve().then(() => this.#create(input, requestId));
  }

  transitionIntent(
    id: string,
    expect: Expected,
    next: IntentState,
    outcome?: Outcome,
  ): Promise<LaunchIntent> {
    return Promise.resolve().then(() => this.#transition(id, expect, next, outcome));
  }

  readIntent(id: string): Promise<LaunchIntent | undefined> {
    const found = this.durable.intents.get(id);
    return Promise.resolve(found === undefined ? undefined : copy(found));
  }

  openWork(machine: string): Promise<{ intents: LaunchIntent[]; runs: RunRecord[] }> {
    const open = new Set<IntentState>(OPEN_STATES);
    const intents = [...this.durable.intents.values()]
      .filter((i) => i.machine === machine && open.has(i.state))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map(copy);
    const runs = [...this.durable.runs.values()]
      .filter((r) => r.machine === machine && isOpenRun(r))
      .sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1))
      .map((r) => structuredClone(r));
    return Promise.resolve({ intents, runs });
  }

  createRun(input: NewRun, requestId: string): Promise<RunRecord> {
    return Promise.resolve().then(() => this.#createRun(input, requestId));
  }

  transitionRun(
    id: string,
    expect: RunExpected,
    next: RunState,
    patch?: RunPatch,
  ): Promise<RunRecord> {
    return Promise.resolve().then(() => this.#transitionRun(id, expect, next, patch));
  }

  readRun(id: string): Promise<RunRecord | undefined> {
    const found = this.durable.runs.get(id);
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  #createRun(value: NewRun, requestId: string): RunRecord {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) {
      throw new RunRefused("invalid", "A request ID is 16 to 64 characters", "requestId");
    }
    const input = checkNewRun(value);
    const { durable } = this;
    const print = fingerprint(input);
    const prior = durable.runReceipts.get(requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== print) {
        throw new RunRefused("request_id_reused", "This request ID was used for another run");
      }
      const found = durable.runs.get(prior.id);
      if (found === undefined) throw new Error("A receipt names a run that is gone");
      return structuredClone(found);
    }
    const now = durable.now();
    // checkNewRun gives the request text as the space stores it (A1 3.7).
    const request = input.request;
    const run: RunRecord = {
      id: randomId("ru"),
      task: input.task,
      routine: input.routine,
      session: input.session ?? null,
      machine: input.machine,
      instance: input.instance,
      adapter: input.adapter,
      place: input.place,
      folderKind: input.place === null ? "work_folder" : "place",
      request,
      briefHash: input.briefHash,
      permission: input.permission,
      limits: input.limits,
      state: "queued",
      reason: null,
      attempt: 1,
      evidence: {},
      at: { queued: now },
      result: null,
      queuedAt: now,
      startedAt: null,
      endedAt: null,
      version: durable.tick(),
    };
    durable.runs.set(run.id, run);
    durable.runReceipts.set(requestId, { id: run.id, fingerprint: print });
    durable.runHistory.push({ id: run.id, from: null, to: "queued", version: run.version });
    return structuredClone(run);
  }

  #transitionRun(id: string, expect: RunExpected, next: RunState, patch?: RunPatch): RunRecord {
    const change = checkRunTransition(id, expect, next, patch);
    const { durable } = this;
    const current = durable.runs.get(change.id);
    if (current === undefined) throw new RunRefused("not_found", "No run has this ID", "id");
    const stale = (field: string): never => {
      throw new RunRefused(
        "stale",
        "The run changed: read it again",
        field,
        structuredClone(current),
      );
    };
    if (current.state !== change.expect.state) stale("expect");
    if (current.version !== change.expect.version) stale("expect.version");
    const held = current.evidence as Record<string, unknown>;
    const incoming = change.evidence as Record<string, unknown>;
    const conflict = Object.keys(incoming).find(
      (key) => held[key] !== undefined && held[key] !== incoming[key],
    );
    if (conflict !== undefined) {
      throw new RunRefused(
        "evidence",
        "The run holds other evidence",
        `patch.evidence.${conflict}`,
        structuredClone(current),
      );
    }
    if (change.result !== undefined && current.result !== null) {
      throw new RunRefused(
        "evidence",
        "The run holds its result",
        "patch.result",
        structuredClone(current),
      );
    }
    const evidence = { ...held, ...incoming };
    const entering = change.next !== current.state;
    const grew = Object.keys(evidence).length > Object.keys(held).length;
    if (!entering && !grew) return structuredClone(current);
    const now = durable.now();
    const final = (FINAL_RUN_STATES as readonly RunState[]).includes(change.next);
    const after: RunRecord = {
      ...current,
      state: change.next,
      reason: entering ? (change.reason ?? null) : current.reason,
      evidence: Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : 1))),
      at: entering ? { ...current.at, [change.next]: now } : current.at,
      result: change.result ?? current.result,
      startedAt:
        entering && change.next === "running" ? (current.startedAt ?? now) : current.startedAt,
      endedAt: entering && final ? now : current.endedAt,
      version: durable.tick(),
    };
    durable.runs.set(after.id, after);
    durable.runHistory.push({
      id: after.id,
      from: current.state,
      to: after.state,
      version: after.version,
    });
    return structuredClone(after);
  }

  #create(value: NewIntent, requestId: string): LaunchIntent {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) {
      throw new ExecutionRefused("invalid", "A request ID is 16 to 64 characters", "requestId");
    }
    const input = checkNewIntent(value);
    const { durable } = this;
    const print = fingerprint(input);
    const prior = durable.receipts.get(requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== print) {
        throw new ExecutionRefused(
          "request_id_reused",
          "This request ID was used for another click",
        );
      }
      const found = durable.intents.get(prior.id);
      if (found === undefined) throw new Error("A receipt names an intent that is gone");
      return copy(found);
    }
    const now = durable.now();
    // A second click on the same task and instance (A4 3.9.1).
    const focus = [...durable.intents.values()]
      .filter(
        (i) =>
          i.task === input.task &&
          i.instance === input.instance &&
          i.machine === input.machine &&
          isOpening(i),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (focus !== undefined) {
      durable.receipts.set(requestId, { id: focus.id, fingerprint: print });
      return copy(focus);
    }
    const held = new Set([...durable.intents.values()].map((i) => i.reference));
    let reference = randomReference();
    while (held.has(reference)) reference = randomReference();
    const intent: LaunchIntent = {
      id: randomId("la"),
      reference,
      task: input.task,
      session: input.session ?? null,
      machine: input.machine,
      instance: input.instance,
      route: input.route,
      place: input.place,
      folderKind: input.place === null ? "work_folder" : "place",
      taskVersion: input.taskVersion,
      briefHash: input.briefHash,
      state: "prepared",
      reason: null,
      evidence: input.evidence ?? {},
      at: { prepared: now },
      createdAt: now,
      updatedAt: now,
      version: durable.tick(),
    };
    durable.intents.set(intent.id, intent);
    durable.receipts.set(requestId, { id: intent.id, fingerprint: print });
    durable.history.push({ id: intent.id, from: null, to: "prepared" });
    return copy(intent);
  }

  #transition(id: string, expect: Expected, next: IntentState, outcome?: Outcome): LaunchIntent {
    const change = checkTransition(id, expect, next, outcome);
    const { durable } = this;
    const current = durable.intents.get(change.id);
    if (current === undefined) {
      throw new ExecutionRefused("not_found", "No launch has this ID", "id");
    }
    if (current.state !== change.expect) {
      throw new ExecutionRefused(
        "stale",
        "The launch moved on: read it again",
        "expect",
        copy(current),
      );
    }
    if (change.version !== undefined && current.version !== change.version) {
      throw new ExecutionRefused(
        "stale",
        "The launch changed: read it again",
        "expect.version",
        copy(current),
      );
    }
    const conflicts = evidenceConflicts(current.evidence, change.evidence);
    if (conflicts.length > 0) {
      throw new ExecutionRefused(
        "evidence",
        "The launch holds other evidence",
        `evidence.${conflicts[0] ?? ""}`,
        copy(current),
      );
    }
    const evidence: Evidence = { ...current.evidence, ...change.evidence };
    const entering = change.next !== current.state;
    const grew = Object.keys(evidence).length > Object.keys(current.evidence).length;
    if (!entering && !grew) return copy(current);
    const now = durable.now();
    const after: LaunchIntent = {
      ...current,
      state: change.next,
      reason: entering ? (change.reason ?? null) : current.reason,
      evidence: Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : 1))),
      at: entering ? { ...current.at, [change.next]: now } : current.at,
      updatedAt: now,
      version: durable.tick(),
    };
    durable.intents.set(after.id, after);
    durable.history.push({ id: after.id, from: current.state, to: after.state });
    return copy(after);
  }
}
