// The UI port (A2 3.8.2), as a decision over injected facts, so every case is tested with injected
// owners and none needs a second account:
//
//   1. `[http] port` set in machine.toml: that port.
//   2. Not set (first start): 7713 to 7733 in order; the first that binds and passes the
//      foreign-holder check is persisted.
//   3. The foreign-holder check runs before the persisted port is bound, and again whenever its
//      bind fails. Every sighting is recorded; a recorded one counts until the user resolves it
//      (`ttasks service port`). A sighting blocks at once, whether or not its record is written.
//   4. Another user holds or recently held the persisted port: no fallback. The service serves no
//      UI (no listener at all), revokes every UI token, and keeps the socket or pipe.
//   5. The persisted port is taken by this user's own process (or a Windows excluded range, whose
//      bind fails with EACCES): an OS-chosen port for this run, `moved`, machine.toml unchanged,
//      and the persisted port tried again every 60 s with the check each time.
import { HolderCheckFailed, type ForeignHolder, type HolderCheck } from "./holders.ts";

/** A2 3.8.2: the ports a first start tries, in order. */
export const PORT_RANGE: readonly number[] = Array.from({ length: 21 }, (_, i) => 7713 + i);
/** A2 3.8.2 step 6: the persisted port is tried again this often while moved. */
export const PORT_RETRY_MS = 60_000;

/** A bound listener, as the decision sees it. */
export interface BoundListener {
  readonly port: number;
  close(): Promise<void>;
}

export interface PortFacts {
  /** Binds 127.0.0.1:`port` (0: a port the OS chooses), or says the port is taken. */
  listen(port: number): Promise<BoundListener | "taken">;
  /** Another user's sockets on `port` (holders.ts). May throw HolderCheckFailed. */
  readonly holders: HolderCheck;
  /** How many recorded sightings of another user `port` has. */
  recorded(port: number): Promise<number>;
  /** Records a sighting. */
  record(port: number, holders: readonly ForeignHolder[]): Promise<void>;
  /** Writes `[http] port` to machine.toml. False, or a throw, when the file could not take it. */
  persist(port: number): boolean;
  /** The check could not run (the OS gave no answer): logged, and the port is treated as free. */
  checkFailed?(): void;
  /**
   * A sighting or a first start's port could not be written: logged. A sighting that is not on
   * disk still blocks this run; only the next start does not know of it.
   */
  writeFailed?(stage: "sighting" | "persist"): void;
}

export type PortChoice =
  | {
      readonly kind: "bound";
      readonly listener: BoundListener;
      /**
       * The persisted port, which is the listener's; undefined when a first start could not
       * write it to machine.toml (the next start chooses again).
       */
      readonly persisted: number | undefined;
      /** True when this start chose the port (step 2). */
      readonly first: boolean;
    }
  | {
      readonly kind: "moved";
      readonly listener: BoundListener;
      /** The persisted port, or undefined when a first start found none of the range free. */
      readonly persisted: number | undefined;
    }
  | { readonly kind: "blocked"; readonly persisted: number };

/** The foreign holders of `port`; a check that cannot run counts as none, and is reported. */
async function holdersOf(
  facts: PortFacts,
  port: number,
  bindFailed: boolean,
): Promise<ForeignHolder[]> {
  try {
    return await facts.holders(port, { bindFailed });
  } catch (error) {
    if (!(error instanceof HolderCheckFailed)) throw error;
    facts.checkFailed?.();
    return [];
  }
}

/**
 * Records a sighting. A write that fails is reported and changes nothing else: the sighting has
 * been made, so the caller blocks (or skips the port) all the same.
 */
async function note(
  facts: PortFacts,
  port: number,
  holders: readonly ForeignHolder[],
): Promise<void> {
  try {
    await facts.record(port, holders);
  } catch {
    facts.writeFailed?.("sighting");
  }
}

/** Binds a port this run may use when the persisted one cannot: one the OS chooses. */
async function fallback(facts: PortFacts): Promise<BoundListener> {
  const listener = await facts.listen(0);
  if (listener === "taken") throw new Error("No port is free on 127.0.0.1");
  return listener;
}

/** A2 3.8.2's choice at start. */
export async function choosePort(
  configured: number | undefined,
  facts: PortFacts,
  range: readonly number[] = PORT_RANGE,
): Promise<PortChoice> {
  if (configured !== undefined) {
    if ((await facts.recorded(configured)) > 0) return { kind: "blocked", persisted: configured };
    const before = await holdersOf(facts, configured, false);
    if (before.length > 0) {
      await note(facts, configured, before);
      return { kind: "blocked", persisted: configured };
    }
    const listener = await facts.listen(configured);
    if (listener !== "taken")
      return { kind: "bound", listener, persisted: configured, first: false };
    const after = await holdersOf(facts, configured, true);
    if (after.length > 0) {
      await note(facts, configured, after);
      return { kind: "blocked", persisted: configured };
    }
    return { kind: "moved", listener: await fallback(facts), persisted: configured };
  }
  for (const port of range) {
    if ((await facts.recorded(port)) > 0) continue;
    const before = await holdersOf(facts, port, false);
    if (before.length > 0) {
      await note(facts, port, before);
      continue;
    }
    const listener = await facts.listen(port);
    if (listener === "taken") {
      const after = await holdersOf(facts, port, true);
      if (after.length > 0) await note(facts, port, after);
      continue;
    }
    // The listener's own port: the same as `port`, except for 0 (tests), the OS's choice. Only a
    // port that is in machine.toml is reported as persisted. A save that fails, however it fails,
    // keeps the listener: the page works this run.
    let saved: boolean;
    try {
      saved = facts.persist(listener.port);
    } catch {
      saved = false;
    }
    if (saved) {
      return { kind: "bound", listener, persisted: listener.port, first: true };
    }
    facts.writeFailed?.("persist");
    return { kind: "bound", listener, persisted: undefined, first: true };
  }
  return { kind: "moved", listener: await fallback(facts), persisted: undefined };
}

/** What a retry of the persisted port found (A2 3.8.2 step 6). */
export type RetryOutcome =
  | { readonly kind: "kept" }
  | { readonly kind: "moved_back"; readonly listener: BoundListener }
  | { readonly kind: "blocked" };

/** One retry: the check, then a bind of the persisted port. */
export async function retryPort(persisted: number, facts: PortFacts): Promise<RetryOutcome> {
  if ((await facts.recorded(persisted)) > 0) return { kind: "blocked" };
  const before = await holdersOf(facts, persisted, false);
  if (before.length > 0) {
    await note(facts, persisted, before);
    return { kind: "blocked" };
  }
  const listener = await facts.listen(persisted);
  if (listener !== "taken") return { kind: "moved_back", listener };
  const after = await holdersOf(facts, persisted, true);
  if (after.length > 0) {
    await note(facts, persisted, after);
    return { kind: "blocked" };
  }
  return { kind: "kept" };
}
