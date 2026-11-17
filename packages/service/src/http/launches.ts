// The page's launch tiles and receipts (A5 3.6 launch tile, 3.9 receipts; A7 3.9 M2.13, M2.10).
//
// Open and Copy are A4's `launch.open`, a registry entry the page calls like every other
// (`POST /api/v1/op/launch.open`), on the hub's one launch machine per space: the page's click,
// the shim's claim, recovery after a restart and the sweep all act on the same machine (A4
// 3.9.1's section rule holds across them). This module keeps what the page needs besides: the
// instances it draws a tile for, from the hub's launch service, and a task's last receipts, which
// the page refetches when the change feed names a launch.
//
// No text of a task, brief or composer travels here: a receipt holds IDs, states, instants and
// fixed codes only, as the launch record does, and whether the launch's agent read the person's
// request yet, which only this computer knows.
import { AppError } from "@tasks/contracts";
import {
  INSTANCE_KEY,
  isRoute,
  TASK_ID,
  TERMINAL_APPS,
  TERMINAL_SOURCES,
  type IntentState,
  type Route,
} from "@tasks/launch";
import { findSpace, isAmbiguity } from "../ops/copies.ts";
import type { OpsHost, ServedSpace } from "../ops/index.ts";
import type { HttpLog } from "./events.ts";

/** An instance as the page draws its tile (A5 3.6): a key, a label, a monogram and a ring slot. */
export interface UiInstance {
  /** The instance's key in machine.toml's `[[instance]]`. */
  readonly key: string;
  /** Names the account: "Codex · work". */
  readonly label: string;
  /** A neutral monogram, one or two characters: "Cx". */
  readonly glyph: string;
  /** One of the eight ring slots of A5 3.19. */
  readonly ring: number;
  readonly route: Route;
}

/**
 * The hub's launch service as the page sees it: the instances Open can open a task in here, and
 * a way to hear that a space's launch records changed (the feed catches up at once).
 */
export interface UiLaunchPort {
  instances(): readonly UiInstance[];
  onChange?(listener: (space: string) => void): () => void;
  /** Whether a launch's request waits for its agent or was read; undefined when none is held. */
  requestState?(launch: string): "waiting" | "read" | undefined;
}

/** A launch receipt as the page shows it (A5 3.9). IDs, states, instants and codes only. */
export interface UiReceipt {
  readonly id: string;
  readonly reference: string;
  readonly instance: string;
  readonly route: string;
  readonly state: IntentState;
  readonly reason: string | null;
  /** When it entered each state, milliseconds since 1970. */
  readonly at: Readonly<Partial<Record<IntentState, number>>>;
  /**
   * A terminal launch: the terminal that was Dispatched and why it was chosen, as the
   * fixed words of `[terminal] app` and TERMINAL_SOURCES. Absent before its dispatch, and for a
   * launch recorded by a build that did not record them.
   */
  readonly terminal?: { readonly app: string; readonly source: string };
  /**
   * The person's words this launch holds for its agent: waiting until the agent read them,
   * 
ead once it did. Absent when it holds none, or no longer does (its launch ended, or this
   * service restarted after it ended).
   */
  readonly request?: "waiting" | "read";
}

const MONOGRAM = /^[A-Za-z0-9]{1,2}$/;

/** The port's instances, checked: an entry that is not one is left out, never guessed. */
export function checkInstances(list: readonly UiInstance[]): UiInstance[] {
  const seen = new Set<string>();
  const out: UiInstance[] = [];
  for (const item of list) {
    if (
      !INSTANCE_KEY.test(item.key) ||
      seen.has(item.key) ||
      typeof item.label !== "string" ||
      item.label.length === 0 ||
      item.label.length > 40 ||
      !MONOGRAM.test(item.glyph) ||
      !Number.isInteger(item.ring) ||
      item.ring < 1 ||
      item.ring > 8 ||
      !isRoute(item.route)
    ) {
      continue;
    }
    seen.add(item.key);
    out.push({
      key: item.key,
      label: item.label,
      glyph: item.glyph,
      ring: item.ring,
      route: item.route,
    });
  }
  return out;
}

const invalid = (message: string, field?: string): AppError =>
  new AppError({
    code: "invalid_input",
    message,
    ...(field === undefined ? {} : { data: { field } }),
  });

const LIST_SQL =
  "SELECT id, reference, instance_id, route, state, reason, detail FROM launches " +
  "WHERE task_id = $task ORDER BY created_at DESC, id DESC LIMIT 10";

/** A `launches` row as the page's receipt, or undefined for a detail that does not parse. */
export function receiptOf(row: Record<string, unknown>): UiReceipt | undefined {
  const at: Partial<Record<IntentState, number>> = {};
  let terminal: UiReceipt["terminal"];
  try {
    const detail = JSON.parse(String(row["detail"])) as {
      at?: Record<string, unknown>;
      evidence?: Record<string, unknown>;
    };
    for (const [state, value] of Object.entries(detail.at ?? {})) {
      if (typeof value === "number") at[state as IntentState] = value;
    }
    // Only the fixed words reach the page: anything else is left out, never shown.
    const app = detail.evidence?.["terminal"];
    const source = detail.evidence?.["terminal_source"];
    if (
      typeof app === "string" &&
      typeof source === "string" &&
      app !== "auto" &&
      (TERMINAL_APPS as readonly string[]).includes(app) &&
      (TERMINAL_SOURCES as readonly string[]).includes(source)
    ) {
      terminal = { app, source };
    }
  } catch {
    return undefined;
  }
  const reason = row["reason"];
  return {
    id: String(row["id"]),
    reference: String(row["reference"]),
    instance: String(row["instance_id"]),
    route: String(row["route"]),
    state: String(row["state"]) as IntentState,
    reason: typeof reason === "string" ? reason : null,
    at,
    ...(terminal === undefined ? {} : { terminal }),
  };
}

export interface UiLaunchesOptions {
  readonly host: OpsHost;
  readonly port: UiLaunchPort | undefined;
  readonly log: HttpLog;
  /** A launch record changed: the feed's subscribers of that space catch up. */
  readonly changed: (space: string) => void;
}

/** The page's tiles and receipts, over the hub's launch service. */
export class UiLaunches {
  readonly #options: UiLaunchesOptions;
  readonly #unlisten: (() => void) | undefined;

  constructor(options: UiLaunchesOptions) {
    this.#options = options;
    this.#unlisten = options.port?.onChange?.((space) => {
      options.changed(space);
    });
  }

  /** The instances the page draws a tile for. None without a launch service: Copy only. */
  instances(): UiInstance[] {
    const port = this.#options.port;
    return port === undefined ? [] : checkInstances(port.instances());
  }

  close(): void {
    this.#unlisten?.();
  }

  /**
   * The served space a request names (its `Tasks-Space`): an ID or a name, the copy of it that
   * copies.ts's rule picks among the served copies (A2 3.10.5).
   */
  #space(ref: string | undefined): ServedSpace {
    if (ref === undefined) throw invalid("Name the space of this tab.", "space");
    const found = findSpace(
      this.#options.host.spaces().filter((s) => s.id !== undefined && s.reader !== undefined),
      ref,
    );
    const space = isAmbiguity(found) ? undefined : found;
    if (space?.reader === undefined || space.id === undefined) {
      throw new AppError({
        code: "space_unavailable",
        message: "This space cannot open tasks on this machine now.",
      });
    }
    return space;
  }

  /** A task's launch receipts, newest last (at most ten). */
  async list(spaceRef: string | undefined, input: Record<string, unknown>): Promise<UiReceipt[]> {
    const { task } = input;
    if (typeof task !== "string" || !TASK_ID.test(task))
      throw invalid("Expected a task ID.", "task");
    const reader = this.#space(spaceRef).reader;
    if (reader === undefined) throw invalid("The space is not served.", "space");
    const rows = await reader.all(LIST_SQL, { task });
    const port = this.#options.port;
    return rows
      .flatMap((r) => receiptOf(r) ?? [])
      .map((receipt) => {
        const request = port?.requestState?.(receipt.id);
        return request === undefined ? receipt : { ...receipt, request };
      })
      .reverse();
  }
}
