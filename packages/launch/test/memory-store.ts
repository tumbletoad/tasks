// An execution store in memory, for tests: the reference backend of the contract suite. Its durable
// state is a separate object, so a test can drop a store (a crash) and build another on the same
// state (a restart). Each call is atomic because it runs synchronously between two awaits, and it
// stores copies, so no caller can change a record except through a call.
import {
  apart,
  evidenceConflicts,
  FOCUS_MS,
  REF_ALPHABET,
  REFERENCE_WINDOW_MS,
  launchRefCheck,
  OPEN_STATES,
  type Evidence,
  type IntentState,
} from "../src/intents.ts";
import {
  checkNewIntent,
  checkTransition,
  ExecutionRefused,
  type ExecutionStore,
  type Expected,
  type LaunchIntent,
  type NewIntent,
  type Outcome,
} from "../src/store.ts";

/** What survives a crash: the records, the receipts and the clock. */
export class MemoryDurable {
  readonly intents = new Map<string, LaunchIntent>();
  /** Request ID → the intent's ID and the input's fingerprint. */
  readonly receipts = new Map<string, { id: string; fingerprint: string }>();
  /** Every committed transition, in order, for invariant checks. */
  readonly history: { id: string; from: IntentState | null; to: IntentState }[] = [];
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

/** The fingerprint of a click's input: its JSON with the keys in order. */
function fingerprint(input: NewIntent): string {
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

  openWork(machine: string): Promise<{ intents: LaunchIntent[] }> {
    const open = new Set<IntentState>(OPEN_STATES);
    const intents = [...this.durable.intents.values()]
      .filter((i) => i.machine === machine && open.has(i.state))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map(copy);
    return Promise.resolve({ intents });
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
          (i.state === "dispatching" || !apart(now, i.createdAt, FOCUS_MS)),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (focus !== undefined) {
      durable.receipts.set(requestId, { id: focus.id, fingerprint: print });
      return copy(focus);
    }
    const recent = new Set(
      [...durable.intents.values()]
        .filter((i) => now - i.createdAt < REFERENCE_WINDOW_MS)
        .map((i) => i.reference),
    );
    let reference = randomReference();
    while (recent.has(reference)) reference = randomReference();
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
