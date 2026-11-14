// A clock for the service's local server (ServeOptions.timers) and its HTTP listener (HttpStart.timers),
// generic over the kinds of timer, so a test observes a connection's
// own deadlines instead of guessing them from wall-clock time or from the process's timers.
// Every timer the server starts is recorded with its kind, its connection and its state. Kinds
// the test makes virtual fire only when the test moves the virtual time on or fires them; the
// other kinds are Node's real timers, still recorded. Tests only.
import type { ServerTimer, TimerKind } from "../src/local/index.ts";

export interface TimerRecord<K extends string = TimerKind> {
  readonly kind: K;
  /** The connection's ID, or undefined for the server's own timer. */
  readonly conn: number | undefined;
  readonly ms: number;
  readonly virtual: boolean;
  /** live: may still fire; cleared: the server stopped it; fired: it ran. */
  state: "live" | "cleared" | "fired";
  /** How often the server started its time again. */
  refreshes: number;
  /** Virtual timers: the virtual time at which it fires. */
  due: number;
}

export interface TimerFilter<K extends string = TimerKind> {
  readonly kind?: K;
  readonly conn?: number;
}

/** A timer factory of the kinds `K`: the shape of the local server's and the HTTP listener's. */
export type Timers<K extends string> = (
  spec: { readonly kind: K; readonly conn: number | undefined; readonly ms: number },
  fire: () => void,
) => ServerTimer;

export interface TestClock<K extends string = TimerKind> {
  /** Pass this as `timers` in the serve options. */
  readonly timers: Timers<K>;
  /** Every timer started, in order. */
  readonly all: readonly TimerRecord<K>[];
  /** The virtual time in ms: it moves only with `advance`. */
  readonly now: number;
  /** The timers that match `filter`, in order. */
  find(filter?: TimerFilter<K>): TimerRecord<K>[];
  /** The live timers that match `filter`. */
  live(filter?: TimerFilter<K>): TimerRecord<K>[];
  /** Moves the virtual time on by `ms`, firing each virtual timer that falls due, in order. */
  advance(ms: number): void;
  /** Fires a live timer now, virtual or real. */
  fire(record: TimerRecord<K>): void;
}

/**
 * A clock whose `virtual` kinds ("all" for every kind) never fire on their own. Without
 * `virtual`, every timer is a real one, recorded.
 */
export function testClock<K extends string = TimerKind>(
  options: { virtual?: readonly NoInfer<K>[] | "all" } = {},
): TestClock<K> {
  const all: TimerRecord<K>[] = [];
  const fires = new Map<TimerRecord<K>, () => void>();
  let now = 0;
  const isVirtual = (kind: K) =>
    options.virtual === "all" || (options.virtual?.includes(kind) ?? false);
  const matches = (record: TimerRecord<K>, filter: TimerFilter<K>) =>
    (filter.kind === undefined || record.kind === filter.kind) &&
    (filter.conn === undefined || record.conn === filter.conn);

  /** Runs a live timer's callback once, as Node does when it falls due. */
  const run = (record: TimerRecord<K>) => {
    if (record.state !== "live") throw new Error(`the ${record.kind} timer is ${record.state}`);
    record.state = "fired";
    fires.get(record)?.();
  };

  const timers: Timers<K> = (spec, fire) => {
    const record: TimerRecord<K> = {
      kind: spec.kind,
      conn: spec.conn,
      ms: spec.ms,
      virtual: isVirtual(spec.kind),
      state: "live",
      refreshes: 0,
      due: now + spec.ms,
    };
    all.push(record);
    if (record.virtual) {
      fires.set(record, fire);
      return {
        refresh: () => {
          // Like Node: a cleared timer stays cleared, a fired one starts again.
          if (record.state === "cleared") return;
          record.state = "live";
          record.refreshes += 1;
          record.due = now + spec.ms;
        },
        clear: () => {
          if (record.state === "live") record.state = "cleared";
        },
      };
    }
    const handle = setTimeout(() => {
      run(record);
    }, spec.ms);
    fires.set(record, () => {
      clearTimeout(handle);
      fire();
    });
    return {
      refresh: () => {
        if (record.state === "cleared") return;
        record.state = "live";
        record.refreshes += 1;
        handle.refresh();
      },
      clear: () => {
        clearTimeout(handle);
        if (record.state === "live") record.state = "cleared";
      },
    };
  };

  return {
    timers,
    all,
    get now() {
      return now;
    },
    find: (filter = {}) => all.filter((record) => matches(record, filter)),
    live: (filter = {}) =>
      all.filter((record) => record.state === "live" && matches(record, filter)),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next: TimerRecord<K> | undefined;
        for (const record of all) {
          if (!record.virtual || record.state !== "live" || record.due > end) continue;
          if (next === undefined || record.due < next.due) next = record;
        }
        if (next === undefined) break;
        now = next.due;
        run(next);
      }
      now = end;
    },
    fire: run,
  };
}
