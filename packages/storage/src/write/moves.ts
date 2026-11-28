// How a launch and a run move (A4 3.9.1, 3.11.2, 3.16.1), for today's writer and the tree's alike:
// an edge of the state machine, a reason code exactly when a state takes one, one compare-and-set
// on the state (and the version) the caller saw, evidence that only grows, and a run's result
// written once, entering a final state. Neither schema writes these rules a second time.
import { detailText, LAUNCH_EDGES, type LaunchRecord } from "./launches.ts";
import {
  LAUNCH_FAIL_REASONS,
  LAUNCH_UNKNOWN_REASONS,
  type LaunchTransition,
  type RunTransition,
} from "./request.ts";
import {
  FINAL_RUN_STATES,
  RUN_EDGES,
  RUN_REASONS,
  runDetailText,
  sortedJson,
  type RunRow,
  type RunState,
} from "./runs.ts";

/** Why a move is refused: the field, and a fixed message. */
export interface MoveProblem {
  code: "VALIDATION_FAILED" | "INVALID_TRANSITION";
  field: string;
  message: string;
}

const refuse = (code: MoveProblem["code"], field: string, message: string): MoveProblem => ({
  code,
  field,
  message,
});

/** Whether a launch's move keeps the state machine's rules, from the request alone. */
export function launchMoveProblem(op: Omit<LaunchTransition, "kind">): MoveProblem | undefined {
  if (!LAUNCH_EDGES[op.expect].includes(op.next)) {
    return refuse("VALIDATION_FAILED", "next", "Not a transition of the launch state machine");
  }
  const entering = op.next !== op.expect;
  const needsReason = entering && (op.next === "failed" || op.next === "unknown");
  if (needsReason !== (op.reason !== undefined)) {
    return refuse(
      "VALIDATION_FAILED",
      "reason",
      needsReason
        ? "Entering Failed or Unknown takes a reason code"
        : "Only entering Failed or Unknown takes a reason code",
    );
  }
  const reasons: readonly string[] =
    op.next === "failed" ? LAUNCH_FAIL_REASONS : LAUNCH_UNKNOWN_REASONS;
  if (needsReason && !reasons.includes(op.reason ?? "")) {
    return refuse("VALIDATION_FAILED", "reason", "Not a reason code of that state");
  }
  return undefined;
}

export interface LaunchWrite {
  state: string;
  reason: string | null;
  detail: string;
}

/**
 * What a launch's move writes on the record as it stands, at the wall clock's `wall`: a refusal,
 * the columns to write, or undefined when it changes nothing.
 */
export function launchAfter(
  current: LaunchRecord,
  op: Omit<LaunchTransition, "kind">,
  wall: number,
): { problem: MoveProblem } | { write: LaunchWrite } | undefined {
  if (current.state !== op.expect) {
    return {
      problem: refuse("INVALID_TRANSITION", "expect", "The launch moved on: read it again"),
    };
  }
  // The record the caller decided on: any change since, a self edge's evidence included, makes the
  // decision stale (a sweep that read the launch before its claim).
  if (op.expect_version !== undefined && current.version !== op.expect_version) {
    return {
      problem: refuse("INVALID_TRANSITION", "expect_version", "The launch changed: read it again"),
    };
  }
  const held = current.evidence;
  const incoming = op.evidence ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(held, key) && held[key] !== value) {
      return {
        problem: refuse("INVALID_TRANSITION", `evidence.${key}`, "The launch holds other evidence"),
      };
    }
  }
  const entering = op.next !== current.state;
  const grows = Object.keys(incoming).some((key) => !Object.hasOwn(held, key));
  if (!entering && !grows) return undefined;
  return {
    write: {
      state: op.next,
      reason: entering ? (op.reason ?? null) : current.reason,
      detail: detailText({
        evidence: { ...held, ...incoming },
        at: entering ? { ...current.at, [op.next]: wall } : current.at,
      }),
    },
  };
}

/** Whether a run's move keeps the state machine's rules, from the request alone. */
export function runMoveProblem(op: Omit<RunTransition, "kind">): MoveProblem | undefined {
  if (!RUN_EDGES[op.expect].includes(op.next)) {
    return refuse("VALIDATION_FAILED", "next", "Not a transition of the run state machine");
  }
  const entering = op.next !== op.expect;
  const reasons = RUN_REASONS[op.next];
  const needsReason = entering && reasons !== undefined;
  if (needsReason !== (op.reason !== undefined)) {
    return refuse(
      "VALIDATION_FAILED",
      "reason",
      needsReason
        ? "Entering this state takes a reason code"
        : "Only entering failed, timed_out or unknown takes a reason code",
    );
  }
  if (needsReason && !reasons.includes(op.reason ?? "")) {
    return refuse("VALIDATION_FAILED", "reason", "Not a reason code of that state");
  }
  const final = (FINAL_RUN_STATES as readonly RunState[]).includes(op.next);
  if (op.result !== undefined && !(entering && final)) {
    return refuse("VALIDATION_FAILED", "result", "A result goes in entering a final state");
  }
  return undefined;
}

export interface RunWrite {
  state: string;
  reason: string | null;
  detail: string;
  result: string;
  started_at: number | null;
  ended_at: number | null;
}

/** What a run's move writes on the record as it stands, at `wall`, as `launchAfter` does. */
export function runAfter(
  current: RunRow,
  op: Omit<RunTransition, "kind">,
  wall: number,
): { problem: MoveProblem } | { write: RunWrite } | undefined {
  if (current.state !== op.expect) {
    return { problem: refuse("INVALID_TRANSITION", "expect", "The run moved on: read it again") };
  }
  if (current.version !== op.expect_version) {
    return {
      problem: refuse("INVALID_TRANSITION", "expect_version", "The run changed: read it again"),
    };
  }
  const held = current.evidence;
  const incoming = op.evidence ?? {};
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(held, key) && held[key] !== value) {
      return {
        problem: refuse("INVALID_TRANSITION", `evidence.${key}`, "The run holds other evidence"),
      };
    }
  }
  // A result goes in once: a run settled from unknown keeps the result it already has.
  if (op.result !== undefined && current.result !== null) {
    return { problem: refuse("INVALID_TRANSITION", "result", "The run holds its result") };
  }
  const entering = op.next !== current.state;
  const grows = Object.keys(incoming).some((key) => !Object.hasOwn(held, key));
  if (!entering && !grows) return undefined;
  const final = (FINAL_RUN_STATES as readonly RunState[]).includes(op.next);
  return {
    write: {
      state: op.next,
      reason: entering ? (op.reason ?? null) : current.reason,
      detail: runDetailText({
        evidence: { ...held, ...incoming },
        at: entering ? { ...current.at, [op.next]: wall } : current.at,
      }),
      result:
        op.result === undefined
          ? current.result === null
            ? "{}"
            : sortedJson(current.result)
          : sortedJson(op.result),
      started_at:
        entering && op.next === "running" ? (current.started_at ?? wall) : current.started_at,
      ended_at: entering && final ? wall : current.ended_at,
    },
  };
}
