// A request the edit queue waits on: a person's edit, a
// check-off, an undo or a redo. Plain code without React.
//
// The queue keeps the order the person acted in, so it waits for each request's outcome. An
// outcome is known once the service decided the request: its answer, a refusal it decided, or the
// request's receipt. It is not known while no answer has come, or when the call failed on
// the way: the request may be in the service's queue still, and apply later.
//
// - No answer after `ASK_MS`, or a failure on the way: the page asks for the outcome by the
//   request's own ID (`receipt.get`, a read the service answers even while its writer is busy) and
//   sends the request again with the same ID and input, which applies it at most once (the
//   writer replays a decided request, and one that races its first call). The first decision of
//   any of them is the outcome.
// - No decision within `ASK_MS` more, asked again every `AGAIN_MS` while the calls fail on the way
//   (the service is down, restarting or hangs, or the tab was stalled): the outcome is unknown. The
//   request keeps its place: whatever waits behind it is not sent (`NotSent`), and the caller keeps
//   the person's value as not saved. The next wait on it asks again, so Try again goes out once
//   the outcome is known, never before it.
// - A decision that comes later (the answer, or the feed naming the request) is still taken.
//
// An outcome is decided once: the first decision. What depends on it runs from that decision and
// nothing else (`noted` before anything waiting on the call goes on, `decided` for the rest), so an
// answer or receipt that arrives after it changes nothing.
import type { Client } from "@ttasks/contracts/generated/client.ts";

/**
 * How long the page waits for an answer before it asks for the outcome, and then for the outcome:
 * about when a person notices that nothing happened. Asking never treats the request as lost (a
 * late answer is still taken), and costs one read and a replay, so it can come early.
 */
export const ASK_MS = 5_000;
const STALL_MARGIN_MS = 1_000;
/** The pause before a send and a read that both failed on the way are tried again. */
export const AGAIN_MS = 500;

/** The request got no decision the page could learn: it may still apply later. */
export class Unanswered extends Error {
  override readonly name = "Unanswered";
}

/** Not sent: a request before it in the queue has an outcome the page could not learn. */
export class NotSent extends Error {
  override readonly name = "NotSent";
}

export type Receipt = Awaited<ReturnType<Client["receipt"]["get"]>>;
export type Found = Extract<Receipt, { found: true }>;

export type Decision<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface Timers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface CallDeps {
  /** `receipt.get` by the request's ID. */
  readonly receipt: (request: string) => Promise<Receipt>;
  readonly timers: Timers;
  /** Whether an error is the service's decision about the request, or the page's own state. */
  readonly decided: (error: unknown) => boolean;
  /** False once the tab's session stopped (closed, signed out): it asks nothing more. */
  readonly alive: () => boolean;
}

/** A place in the queue: what waits behind it waits for this. */
export interface Turn {
  /** True once the outcome is known; false when it could not be learned (asked again next time). */
  wait(): Promise<boolean>;
}

/** A turn with nothing to wait for. */
export const KNOWN: Turn = { wait: () => Promise.resolve(true) };

/** Every turn known: false as soon as one of them is not. */
export const allOf = (turns: readonly Turn[]): Turn =>
  turns.length === 0
    ? KNOWN
    : {
        wait: async () => (await Promise.all(turns.map((turn) => turn.wait()))).every(Boolean),
      };

/** A stalled page can run an overdue timer before a ready response. Give that response one more wait. */
function after(timers: Timers, ms: number): { done: Promise<void>; stop: () => void } {
  let handle: unknown;
  const done = new Promise<void>((resolve) => {
    const due = Date.now() + ms;
    handle = timers.set(() => {
      if (Date.now() - due > STALL_MARGIN_MS) handle = timers.set(resolve, ms);
      else resolve();
    }, ms);
  });
  return {
    done,
    stop: () => {
      timers.clear(handle);
    },
  };
}

export class Call<T> implements Turn {
  /** The outcome: the service's result or refusal, or `Unanswered`. */
  readonly answer: Promise<T>;
  /** The first decision, whenever it comes (also after `answer` said `Unanswered`). */
  readonly decided: Promise<Decision<T>>;
  readonly #deps: CallDeps;
  readonly #request: string;
  readonly #post: () => Promise<T>;
  readonly #fromReceipt: (found: Found) => Decision<T> | undefined;
  readonly #noted: (decision: Decision<T>) => void;
  #decision: Decision<T> | undefined;
  #decide!: (decision: Decision<T>) => void;
  readonly #first: Promise<boolean>;
  #learning: Promise<boolean> | undefined;
  #firstDone = false;
  /** `answer` said `Unanswered`: the feed naming the request is a reason to ask again. */
  #unknown = false;

  /**
   * `post` sends the request with its ID and input, the same each time; `fromReceipt` reads a found
   * receipt as the decision, or undefined when it cannot. `noted` runs once, for the first
   * decision, before anything that waits on the call goes on (the next edit's base reads it).
   */
  constructor(
    deps: CallDeps,
    request: string,
    post: () => Promise<T>,
    fromReceipt: (found: Found) => Decision<T> | undefined,
    noted: (decision: Decision<T>) => void = () => undefined,
  ) {
    this.#deps = deps;
    this.#request = request;
    this.#post = post;
    this.#fromReceipt = fromReceipt;
    this.#noted = noted;
    this.decided = new Promise((resolve) => {
      this.#decide = (decision) => {
        if (this.#decision !== undefined) return;
        this.#decision = decision;
        this.#noted(decision);
        resolve(decision);
      };
    });
    this.#first = this.#start();
    this.answer = this.#first.then(() => {
      const decision = this.#decision;
      if (decision === undefined) throw new Unanswered();
      if (decision.ok) return decision.value;
      throw decision.error;
    });
    // The caller reads `answer`; a rejection nobody reads is not an unhandled one.
    this.answer.catch(() => undefined);
  }

  /**
   * A wait that begins while the first answer is awaited gets its outcome; one that begins after
   * an unknown outcome asks again.
   */
  wait(): Promise<boolean> {
    if (!this.#firstDone) return this.#first;
    if (this.#decision !== undefined) return Promise.resolve(true);
    return this.#learn();
  }

  /**
   * The feed named the request: it was decided. Read only for a request whose answer said
   * `Unanswered`; on the usual path the answer follows the feed's event within moments.
   */
  heard(): void {
    if (this.#unknown && this.#decision === undefined && this.#learning === undefined) {
      void this.#learn();
    }
  }

  async #start(): Promise<boolean> {
    const first = this.#attempt();
    const deadline = after(this.#deps.timers, ASK_MS);
    await Promise.race([this.decided, first, deadline.done]);
    deadline.stop();
    const known = this.#decision !== undefined || (await this.#learn());
    this.#unknown = !known;
    this.#firstDone = true;
    return known;
  }

  /**
   * Asks for the outcome and sends the request again with its ID, until it is decided or `ASK_MS`
   * has passed. A send and a read that both fail on the way (a tab back from a stall, a service
   * restarting) are tried again after `AGAIN_MS`, so "unknown" means no answer for `ASK_MS`.
   */
  #learn(): Promise<boolean> {
    if (!this.#deps.alive()) return Promise.resolve(false);
    this.#learning ??= (async () => {
      const deadline = after(this.#deps.timers, ASK_MS);
      let over = false;
      const asking = async () => {
        while (!over && this.#decision === undefined && this.#deps.alive()) {
          await Promise.all([this.#attempt(), this.#ask()]);
          if (over || this.#decision !== undefined) return;
          await new Promise((resolve) => this.#deps.timers.set(resolve, AGAIN_MS));
        }
      };
      try {
        await Promise.race([this.decided, asking(), deadline.done]);
      } finally {
        over = true;
        deadline.stop();
        this.#learning = undefined;
      }
      return this.#decision !== undefined;
    })();
    return this.#learning;
  }

  /** One send; settles when it ends, decided or not. */
  async #attempt(): Promise<void> {
    try {
      this.#decide({ ok: true, value: await this.#post() });
    } catch (error) {
      if (this.#deps.decided(error)) this.#decide({ ok: false, error });
    }
  }

  async #ask(): Promise<void> {
    try {
      const receipt = await this.#deps.receipt(this.#request);
      if (!receipt.found) return;
      const decision = this.#fromReceipt(receipt);
      if (decision !== undefined) this.#decide(decision);
    } catch {
      // The service cannot say now: the outcome stays unknown.
    }
  }
}
