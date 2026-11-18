// The browser's way into the service, as one running part of the hub (A2 3.8): the grants table in
// service.sqlite, the port decision, the listener, the retry of a busy persisted port, and the
// block when another user holds or held the port. The hub starts it after the local endpoint is
// bound and before `ready`, reports `status()` in service.json and `service/status`, and stops it
// first in the drain (hub/service.ts).
import { PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import { editMachineToml } from "../config/edit.ts";
import type { OpsHost } from "../ops/index.ts";
import {
  HttpApp,
  type UiApps,
  type UiDefaultSpace,
  type UiFolders,
  type UiMachine,
  type UiSpaces,
} from "./app.ts";
import type { HttpLog } from "./events.ts";
import type { Visibility } from "./feed.ts";
import { DurableGrants } from "./grants.ts";
import {
  osHolderCheck,
  osPeerCheck,
  osRedeemCheck,
  type HolderCheck,
  type PeerCheck,
  type RedeemCheck,
} from "./holders.ts";
import type { UiLaunchPort } from "./launches.ts";
import { DEFAULT_HTTP_LIMITS, type HttpLimits } from "./limits.ts";
import { isTaken, listenHttp, type HttpListener } from "./listener.ts";
import { blockedMessage } from "./messages.ts";
import { builtinUi, loadUiFolder, type UiBundle } from "./page.ts";
import {
  choosePort,
  PORT_RANGE,
  PORT_RETRY_MS,
  retryPort,
  type BoundListener,
  type PortFacts,
} from "./port.ts";
import { ServiceDb } from "./service-db.ts";
import { nodeHttpTimers, type StartHttpTimer } from "./timers.ts";

/** What service.json's `http` and `service/status` say (A2 3.2.3). */
export interface HttpStatus {
  readonly host: "127.0.0.1";
  /** The port the UI is served on now; when blocked, the persisted port it is not served on. */
  readonly port: number | null;
  /** machine.toml's `[http] port` (A2 3.8.2), when one is persisted. */
  readonly persisted: number | null;
  /** The persisted port was busy with this user's own process: a port for this run only. */
  readonly moved: boolean;
  /** `foreign_port_holder`: another user holds or held the port, so no UI is served. */
  readonly blocked: "foreign_port_holder" | null;
}

/** How the hub starts the listener. Every field has the product's default. Tests pass others. */
export interface HttpStart {
  /** A first start's candidates (A2 3.8.2: 7713 to 7733). Tests pass ports they own, or [0]. */
  readonly ports?: readonly number[];
  /** Write the chosen port to machine.toml (default true). */
  readonly persist?: boolean;
  readonly holders?: HolderCheck;
  readonly peerCheck?: PeerCheck;
  readonly redeemCheck?: RedeemCheck;
  readonly limits?: Partial<HttpLimits>;
  readonly timers?: StartHttpTimer;
  readonly now?: () => number;
  /** A built UI folder (packages/web, M2.13), or a bundle. Default: page.ts's minimal shell. */
  readonly ui?: string | UiBundle;
  /** Which commits a feed subscriber sees (v1: all). */
  readonly visible?: Visibility;
  /** The installed version when it is not the one this service runs, for the page. Default: none. */
  readonly installed?: () => string | undefined;
}

export interface HttpOptions extends HttpStart {
  readonly stateDir: string;
  readonly configDir: string;
  /** machine.toml's `[http] port`. */
  readonly configured: number | undefined;
  readonly key: Uint8Array;
  readonly instance: string;
  readonly build: { readonly version: string; readonly build: string };
  readonly ops: OpsHost;
  readonly db: ServiceDb;
  readonly grants: DurableGrants;
  readonly log: HttpLog;
  /** The machine's default space, which the page's Make default changes. */
  readonly defaults?: UiDefaultSpace;
  /** This machine's settings, which the page's Settings reads and changes. */
  readonly machine?: UiMachine;
  /** New space and Open folder in the page. */
  readonly spaces?: UiSpaces;
  /** This machine's agent apps in the page. */
  readonly apps?: UiApps;
  /** The page's folder chooser. */
  readonly folders?: UiFolders;
  /** The status changed (a block, a move back): the hub rewrites service.json. */
  readonly onChange?: () => void;
  /**
   * The hub's launch service behind the page's tiles (launches.ts): the same launch machine per
   * space as the shim's claims, recovery and the sweep. Default: none, Copy only.
   */
  readonly launch?: UiLaunchPort;
}

export interface RunningHttp {
  readonly app: HttpApp;
  status(): HttpStatus;
  /** `ui/mint_code`: a code and the port to use it on, or the reason there is none. */
  mintCode(): { code: string; port: number; persisted: number | null; moved: boolean };
  /** `tasks service port <n> [--reuse]` (A2 3.8.2 step 5): machine.toml and the observations. */
  setPort(port: number, reuse: boolean): Promise<void>;
  close(): Promise<void>;
}

/** Opens service.sqlite and its grants table: before the local endpoint, which uses the table. */
export async function openGrants(
  stateDir: string,
  log: HttpLog,
): Promise<{ db: ServiceDb; grants: DurableGrants }> {
  const db = await ServiceDb.open(stateDir);
  try {
    const grants = await DurableGrants.open(db, {
      onFailure: () => {
        log({ ev: "http.grants_failed", stage: "write" });
      },
    });
    return { db, grants };
  } catch (error) {
    await db.close();
    throw error;
  }
}

const OS_WORD: Readonly<Partial<Record<NodeJS.Platform, "linux" | "windows" | "macos">>> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

/** Starts the listener (A2 3.8.1, 3.8.2). Resolves with it bound, moved or blocked. */
export async function startHttp(options: HttpOptions): Promise<RunningHttp> {
  const limits: HttpLimits = { ...DEFAULT_HTTP_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const timers = options.timers ?? nodeHttpTimers;
  const peerCheck = options.peerCheck ?? osPeerCheck();
  const ui =
    options.ui === undefined
      ? builtinUi(options.build)
      : typeof options.ui === "string"
        ? loadUiFolder(options.ui, options.build)
        : options.ui;
  const app = new HttpApp({
    key: options.key,
    instance: options.instance,
    build: options.build,
    grants: options.grants,
    ops: options.ops,
    ui,
    log: options.log,
    limits,
    now,
    timers,
    redeemCheck: options.redeemCheck ?? osRedeemCheck(),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
    ...(options.installed === undefined ? {} : { installed: options.installed }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(options.spaces === undefined ? {} : { spaces: options.spaces }),
    ...(options.apps === undefined ? {} : { apps: options.apps }),
    ...(options.folders === undefined ? {} : { folders: options.folders }),
  });
  const os = OS_WORD[process.platform] ?? "linux";
  const facts: PortFacts = {
    listen: async (port) => {
      try {
        return await listenHttp(app, port, peerCheck);
      } catch (error) {
        if (isTaken(error)) return "taken";
        throw error;
      }
    },
    holders: options.holders ?? osHolderCheck(),
    recorded: async (port) => (await options.db.observations(port)).length,
    record: (port, holders) =>
      options.db.recordHolders(
        port,
        new Date(now()),
        holders.map((h) => h.owner),
      ),
    persist: (port) =>
      options.persist === false ||
      editMachineToml(options.configDir, [{ op: "set", table: ["http"], key: "port", value: port }])
        .ok,
    checkFailed: () => {
      options.log({ ev: "http.holder_check_failed", os });
    },
    writeFailed: (stage) => {
      options.log({ ev: "http.port_write_failed", stage });
    },
  };

  let listener: BoundListener | undefined;
  let persisted: number | null = options.configured ?? null;
  let moved = false;
  let blocked = false;
  let retry: { clear(): void } | undefined;
  let closed = false;

  const block = () => {
    blocked = true;
    const revoked = app.block();
    options.log({ ev: "http.blocked", revoked });
  };

  // A listener that cannot be bound at all (no loopback address, say) leaves the service without
  // a UI, never without its socket: `tasks open` and doctor then say the listener is not running.
  const choice = await choosePort(options.configured, facts, options.ports ?? PORT_RANGE).catch(
    () => undefined,
  );
  if (choice?.kind === "blocked") {
    persisted = choice.persisted;
    block();
  } else if (choice !== undefined) {
    listener = choice.listener;
    persisted = choice.persisted ?? null;
    moved = choice.kind === "moved";
  }
  options.log({
    ev: "http.listening",
    outcome:
      choice === undefined
        ? "none"
        : choice.kind === "blocked"
          ? "blocked"
          : choice.kind === "moved"
            ? "moved"
            : choice.first
              ? "first"
              : "persisted",
    moved,
  });

  // A2 3.8.2 step 6: while moved, the persisted port is tried again every 60 s.
  const scheduleRetry = (target: number) => {
    let busy = false;
    const timer = timers({ kind: "port_retry", conn: undefined, ms: PORT_RETRY_MS }, () => {
      if (busy || closed) return;
      busy = true;
      void retryPort(target, facts)
        .then(async (outcome) => {
          if (closed) {
            if (outcome.kind === "moved_back") await outcome.listener.close();
            return;
          }
          options.log({ ev: "http.port_retry", outcome: outcome.kind });
          if (outcome.kind === "kept") {
            timer.refresh();
            return;
          }
          const old = listener;
          if (outcome.kind === "moved_back") {
            listener = outcome.listener;
            moved = false;
          } else {
            listener = undefined;
            block();
          }
          await old?.close();
          options.onChange?.();
        })
        .catch(() => {
          timer.refresh();
        })
        .finally(() => {
          busy = false;
        });
    });
    retry = timer;
  };
  if (moved && persisted !== null) scheduleRetry(persisted);

  const status = (): HttpStatus => ({
    host: "127.0.0.1",
    port: blocked ? persisted : (listener?.port ?? null),
    persisted,
    moved,
    blocked: blocked ? "foreign_port_holder" : null,
  });

  return {
    app,
    status,
    mintCode: () => {
      if (blocked) {
        throw new AppError({
          code: "service_unavailable",
          message: blockedMessage(persisted),
          hint: "tasks service port <n>",
          data: { reason: "ui_blocked", retryable: false },
        });
      }
      if (listener === undefined) {
        throw new AppError({
          code: "service_unavailable",
          message: `${PRODUCT_NAME}'s UI listener is not running.`,
          hint: "Run: tasks doctor",
          data: { reason: "ui_unavailable", retryable: false },
        });
      }
      return { code: app.mintCode(), port: listener.port, persisted, moved };
    },
    setPort: async (port, reuse) => {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new AppError({
          code: "invalid_input",
          message: "A port is a number from 1024 to 65535.",
          data: { issues: [{ path: "port", message: "Out of range" }] },
        });
      }
      const recorded = (await options.db.observations(port)).length > 0;
      if ((recorded || (blocked && port === persisted)) && !reuse) {
        throw new AppError({
          code: "invalid_input",
          message: `Another user held port ${String(port)}. Choosing it again needs --reuse.`,
          hint: `tasks service port ${String(port)} --reuse`,
          data: { issues: [{ path: "reuse", message: "Required for this port" }] },
        });
      }
      const edited = editMachineToml(options.configDir, [
        { op: "set", table: ["http"], key: "port", value: port },
      ]);
      if (!edited.ok) {
        throw new AppError({
          code: "invalid_input",
          message: `${PRODUCT_NAME}'s machine.toml could not take the port (${edited.reason}).`,
          hint: "Fix machine.toml, or set [http] port there by hand.",
          data: { reason: edited.reason },
        });
      }
      await options.db.clearObservations();
    },
    close: async () => {
      closed = true;
      retry?.clear();
      app.closeAll();
      await listener?.close();
      listener = undefined;
    },
  };
}

export type { HttpListener };
