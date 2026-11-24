// A driver speaks one agent program's protocol over the pipes the run host gives it, and knows
// nothing of processes: the host starts the program in the run's process group, owns its pipes and
// ends it. What a driver decides is the work's result; what the process group says afterwards is the
// cleanup's, which the host adds and which never changes the work's.
import type { Readable, Writable } from "node:stream";
import type { AppToolsState, OutcomeReason, RunEvent, Usage } from "@ttasks/contracts/runs";
import type { AgentExit } from "../process-group/index.ts";

/** The work's result, as the driver judged it from the protocol. */
export interface Work {
  readonly ok: boolean;
  readonly outcome: OutcomeReason;
  /** The agent's own session or thread ID, kept so the run can be continued. */
  readonly nativeId: string | null;
  /** The answer, or the agent's question when it needs the person (≤ ANSWER_CAP_BYTES). */
  readonly text: string | null;
  readonly textCut: boolean;
  /** The agent finished its turn with `text`. */
  readonly textFinal: boolean;
  /** The agent's own words about what went wrong (≤ TEXT_CAP_BYTES). */
  readonly error: string | null;
  readonly usage: Usage | null;
  /** Whether TTasks's own tools were connected for the agent. */
  readonly appTools: AppToolsState | null;
  /** Requests of the agent that its permission declined. */
  readonly declined: number;
  readonly permissionDenials: number;
}

/** One run's protocol, from its start to its settled work. */
export interface DriverSession {
  /** Settles once, with the work. Never rejects. */
  readonly settled: Promise<Work>;
  /**
   * Asks the agent to stop its work over the protocol, without waiting for anything. False when
   * the protocol has no way to: the host then interrupts the process.
   */
  interrupt(): boolean;
  /** Ends the protocol: the agent's input ends, and one that behaves exits by itself. */
  close(): void;
  /** The agent's output ended: the work settles with what was said, at once. */
  ended(exit: AgentExit): void;
}

export interface DriverPipes {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

/**
 * Starts the protocol on a started agent. Called before anything is awaited, so no output is
 * lost; `report` gets the run's events as they come.
 */
export type OpenDriver = (pipes: DriverPipes, report: (event: RunEvent) => void) => DriverSession;
