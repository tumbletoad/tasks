// The service's side of the launch shim: tickets, the one spawn
// claim, the attachment credential, re-attaching, the shim's reports, and what recovery and the
// PID check observe. Transport-free: the service's rpc handlers (packages/service/src/launch) call
// it with the params as they came and the connection's attachment.
//
// The rules it keeps:
// - A ticket is issued once per intent, when its dispatch starts (the window runs
//   from Dispatching), and stored as a hash bound to its launch (secrets.ts). Its shim role is
//   claimed once, within 120 s of issue, by a process that is alive with exactly the start time
//   the claim names. From the claim until the launch is released it names that live launch for
//   the agent's tools and shell (`liveByTicket`). A ticket can only ever name its own launch.
// - The claim goes through `LaunchMachine.claim`, so it is committed (a fresh random claim ID)
//   before anything leaves for the shim, and refused for a second claim, after the window, on any
//   other route or state. The reply is the claim's injected step: inside the claim's section it
//   stores the credential's hash bound to the launch, the PID and the start time, then sends the
//   agent's argv, the check of the folder its terminal was started in, the environment and the
//   credential. Nothing else ever sends them.
// - The ticket's shim role is spent before the claim commits, so a crash between the two leaves an
//   intent its window ends, never a ticket that claims twice.
// - An attachment is the credential's hash with the same launch, PID and start time, and a process
//   that is alive with that start time. It lets a connection report, never claim: `launch.claim`
//   reads only tickets, and the attach reply carries nothing that starts an agent.
// - The credential lives as long as the shim process: its record goes once the process ended (the
//   exit report, `exit.json`, or the PID check), and with it the ticket's last use.
import { apart, CLAIM_WINDOW_MS, MAX_COUNT, PREPARED_TTL_MS, type Evidence } from "../intents.ts";
import type { LaunchMachine, Observation } from "../machine.ts";
import type { FolderCheck, ResolveReason } from "../places.ts";
import type { ProcessProbe } from "../process.ts";
import { withFolder } from "../routes/argv.ts";
import { SESSION_UUID, type LaunchIntent } from "../store.ts";
import { ADDED, agentEnvironment, type AgentBase } from "./environment.ts";
import {
  checkPlan,
  isFolderReason,
  keptGiven,
  type ClickGiven,
  type LaunchFile,
  type RecordStore,
  type SpawnPlan,
} from "./records.ts";
import { newClaimId, newCredential, newTicket, sameHash, secretHash } from "./secrets.ts";
import {
  checkFolderCheck,
  CREDENTIAL,
  FAILED_REASONS,
  isPid,
  SETTLE_MS,
  SHIM_METHODS,
  SHIM_PROTOCOL,
  START_TIME,
  TICKET,
  type AttachReply,
  type ClaimReply,
  type ExitFile,
  type FailedReason,
  type ReportMethod,
} from "./wire.ts";

/** A launch folder whose shim is gone or that is older than this is removed. */
export const FOLDER_MAX_AGE_MS = 24 * 60 * 60_000;

/** What a connection holds once it claimed or attached: the launch it may report about. */
export interface Attachment {
  readonly space: string;
  readonly launch: string;
  readonly reference: string;
  readonly pid: number;
  readonly startTime: string;
}

/**
 * Why a call was refused, for the service's log. The peer gets one reason word for all of them
 * (wire.ts REFUSED), so a caller learns nothing about a ticket it does not hold.
 */
export const HOST_REFUSALS = [
  "malformed",
  "unknown",
  "used",
  "window",
  "busy",
  "space",
  "process",
  "check_failed",
  "intent",
  "reply_failed",
  "not_attached",
  "store",
] as const;
export type HostRefusal = (typeof HOST_REFUSALS)[number];

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly intent: LaunchIntent; readonly attachment: Attachment }
  | { readonly kind: "refused"; readonly reason: HostRefusal };

export type AttachOutcome =
  | { readonly kind: "attached"; readonly attachment: Attachment; readonly reply: AttachReply }
  | { readonly kind: "refused"; readonly reason: HostRefusal };

export type ReportOutcome =
  | {
      readonly kind: "applied";
      readonly intent: LaunchIntent | undefined;
      readonly ended: boolean;
      /** For a folder the shim's check refused: its reason, which the launch records too. */
      readonly folder?: ResolveReason;
    }
  | { readonly kind: "refused"; readonly reason: HostRefusal };

/** A launch's ID or a background run's: the two things a session is named after. */
const SESSION_SOURCE = /^(?:la|ru)_([0-9a-z]{26})$/;

/**
 * The session a launch or a background run is: the one it continues, or else one named after it,
 * `se_` and the 26 characters of its `la_` or `ru_` ID. So the session exists from the click (or
 * the run's start), and a launch of a build that recorded none is still named. IDs are random, so
 * a launch and a run never share a name.
 */
export function sessionOf(of: { readonly id: string; readonly session?: string | null }): string {
  if (of.session !== undefined && of.session !== null) return of.session;
  const body = SESSION_SOURCE.exec(of.id)?.[1];
  if (body === undefined) throw new Error("Only a launch or a run is named as a session");
  return `se_${body}`;
}

/** A live launch a value names: its session's facts (`ShimHost.liveByTicket`, `liveByPreset`). */
export interface LiveLaunch {
  readonly launch: string;
  readonly space: string;
  /** Null for a routine's launch. */
  readonly task: string | null;
  readonly session: string;
  /** The agent's app and home folder as the click recorded them; a launch can lack either. */
  readonly app?: string;
  readonly home?: string;
  /** The copy of the space the click was made in: its session writes there only. */
  readonly copy?: string;
}

/** Sends the claim's reply to the shim. Resolves once it has left the service. */
export type SendReply = (reply: ClaimReply, attachment: Attachment) => Promise<void>;

export interface ShimHostOptions {
  readonly records: RecordStore;
  readonly probe: ProcessProbe;
  readonly platform: NodeJS.Platform;
  /**
   * The space's launch machine, while the space is open as this machine's from the copy `copy`
   * (a launch's record names the copy its click was made in; none for an earlier build's record):
   * a launch is never reported into another copy of its space.
   */
  readonly machine: (
    space: string,
    copy: string | undefined,
  ) => LaunchMachine | undefined | Promise<LaunchMachine | undefined>;
  /**
   * Where the agent's environment starts for `launch` (environment.ts AgentBase): read at each
   * claim, before the ticket is spent, and never failing (a base that cannot be read is the
   * service's own, through the allow-list). A launch whose plan asks for the login shell gets the
   * snapshot the service took in its folder before the launch.
   */
  readonly environment: (launch: string) => AgentBase | Promise<AgentBase>;
  /** Wall clock milliseconds. Default: Date.now. */
  readonly now?: () => number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStartTime = (value: unknown): value is string =>
  typeof value === "string" && START_TIME.test(value);

const INSTANT_MAX = 253_402_300_799_999;
const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= INSTANT_MAX;

/** The evidence of an exit code: a count when it fits one, else none (a Windows NTSTATUS). */
const exitCode = (code: number | null): Evidence =>
  code !== null && Number.isSafeInteger(code) && code >= 0 && code <= MAX_COUNT
    ? { exit_code: code }
    : {};

/**
 * What an agent's end means for its launch. A folder the shim's check
 * refused is recorded with the folder's own reason, so the task says why.
 */
export function exitObservation(exit: {
  spawned: boolean;
  settled: boolean;
  code: number | null;
  ran_ms: number;
  failed?: FailedReason | undefined;
  folder?: ResolveReason | undefined;
}): Observation {
  if (!exit.spawned || exit.failed !== undefined) {
    const folder = exit.failed === "verify" ? exit.folder : undefined;
    return { kind: "failed", reason: folder ?? "verify_failed" };
  }
  // How long it ran is what tells the page the session ended, also for an exit by a signal.
  const ended: Evidence = {
    ...exitCode(exit.code),
    ran_ms: Math.min(Math.max(0, Math.round(exit.ran_ms)), MAX_COUNT),
  };
  // The session did happen: a settled agent confirms, and one that ended within 3 s failed.
  if (exit.settled || exit.ran_ms >= SETTLE_MS) {
    return { kind: "confirmed", evidence: { folder_checked: true, ...ended } };
  }
  return { kind: "failed", reason: "agent_exited", evidence: ended };
}

export class ShimHost {
  readonly #records: RecordStore;
  readonly #probe: ProcessProbe;
  readonly #platform: NodeJS.Platform;
  readonly #machine: ShimHostOptions["machine"];
  readonly #environment: ShimHostOptions["environment"];
  readonly #now: () => number;
  /**
   * Claims under way: per launch, the hashes of the tickets being claimed. A second claim with the
   * same ticket at the same time is refused (`busy`). A claim with a launch's replacement ticket
   * is not: the one with the revoked ticket ends as `used` when it compares the hash it read, and
   * the replacement's claim must not be refused for good meanwhile (replaceTicket).
   */
  readonly #claiming = new Map<string, Set<string>>();

  constructor(options: ShimHostOptions) {
    this.#records = options.records;
    this.#probe = options.probe;
    this.#platform = options.platform;
    this.#machine = options.machine;
    this.#environment = options.environment;
    this.#now = options.now ?? Date.now;
  }

  /** The environment's base, or the service's empty one when reading it threw. */
  async #base(launch: string): Promise<AgentBase> {
    try {
      return await this.#environment(launch);
    } catch {
      return { kind: "service", env: {} };
    }
  }

  /**
   * Keeps a terminal launch's spawn plan in machine state, at the click (Prepared), with
   * the agent's app, its home and the session ID the click preset for it, and the session the
   * launch is. A repeated click that returned the same intent keeps the record it has.
   */
  prepare(space: string, intent: LaunchIntent, plan: SpawnPlan, given: ClickGiven = {}): void {
    const checked = checkPlan(plan);
    if (checked === undefined) throw new Error("The spawn plan is not one the shim can start");
    if (this.#records.get(intent.id) !== undefined) return;
    this.#records.put({
      format: 1,
      space,
      launch: intent.id,
      reference: intent.reference,
      task: intent.task,
      createdAt: this.#now(),
      plan: checked,
      ...keptGiven(given),
      session: sessionOf(intent),
    });
  }

  /**
   * Issues the launch's ticket, durably as its hash with the folder resolved for it, and returns
   * it: the terminal's dispatch step calls it once, after Dispatching is committed and the folder
   * resolved, and before the terminal starts in that folder. The claim's reply hands the shim the
   * folder's check.
   */
  issueTicket(launch: string, folder: { path: string; check: FolderCheck }): string {
    const record = this.#records.get(launch);
    if (record === undefined) throw new Error("No spawn plan for this launch");
    if (record.ticket !== undefined) throw new Error("This launch has its ticket");
    const check = checkFolderCheck(folder.check);
    if (folder.path === "" || check === undefined) throw new Error("Not a resolved folder");
    const ticket = newTicket();
    this.#records.put({
      ...record,
      folder: { path: folder.path, check },
      ticket: {
        hash: secretHash("ticket", launch, ticket),
        issuedAt: this.#now(),
        shimUsed: false,
      },
    });
    return ticket;
  }

  /**
   * Whether the launch's ticket has had its shim role spent: a claim is under way or done (the
   * shim claimed, for a direct terminal). The spend happens before the claim waits
   * for the intent's section, so the terminal's dispatch step sees it while it still runs.
   */
  ticketSpent(launch: string): boolean {
    return this.#records.get(launch)?.ticket?.shimUsed === true;
  }

  /**
   * A direct terminal took its window with it before any claim: the launch's ticket is
   * revoked and the next terminal gets a new one, with a window of its own. In one synchronous step,
   * so a claim either spent the old ticket first (then nothing is revoked and this returns
   * undefined: a claim came) or finds it gone (a claim already reading it is refused, since it
   * compares the hash it read).
   */
  replaceTicket(launch: string): string | undefined {
    const record = this.#records.get(launch);
    if (record?.ticket === undefined || record.ticket.shimUsed) return undefined;
    const ticket = newTicket();
    this.#records.put({
      ...record,
      ticket: {
        hash: secretHash("ticket", launch, ticket),
        issuedAt: this.#now(),
        shimUsed: false,
      },
    });
    return ticket;
  }

  /** The launch's machine state, for status and tests. Holds hashes, never a secret. */
  record(launch: string): LaunchFile | undefined {
    return this.#records.get(launch);
  }

  /** The record whose ticket is `ticket`: every record is compared, each in constant time. */
  #byTicket(ticket: string): LaunchFile | undefined {
    let found: LaunchFile | undefined;
    for (const record of this.#records.list()) {
      if (record.ticket === undefined) continue;
      if (sameHash(secretHash("ticket", record.launch, ticket), record.ticket.hash)) found = record;
    }
    return found;
  }

  #byCredential(credential: string): LaunchFile | undefined {
    let found: LaunchFile | undefined;
    for (const record of this.#records.list()) {
      if (record.attachment === undefined) continue;
      const hash = secretHash("attachment", record.launch, credential);
      if (sameHash(hash, record.attachment.hash)) found = record;
    }
    return found;
  }

  /**
   * Whether `pid` is alive with exactly `startTime`. Undefined when the OS could not tell, which
   * is never read as gone.
   */
  async #alive(pid: number, startTime: string): Promise<boolean | undefined> {
    try {
      return (await this.#probe.startTimes([pid])).get(pid) === startTime;
    } catch {
      return undefined;
    }
  }

  /**
   * `launch.claim`. `send` is the reply, run inside the claim's section once the
   * claim is durable and the credential is stored.
   */
  async claim(params: unknown, send: SendReply): Promise<ClaimOutcome> {
    if (!isObject(params)) return refused("malformed");
    const { ticket, role, pid, start_time: startTime } = params;
    if (typeof ticket !== "string" || !TICKET.test(ticket) || role !== "shim") {
      return refused("malformed");
    }
    if (!isPid(pid) || !isStartTime(startTime)) return refused("malformed");
    const found = this.#byTicket(ticket);
    if (found?.ticket === undefined) return refused("unknown");
    const { launch, space, copy } = found;
    if (found.ticket.shimUsed) return refused("used");
    const hash = found.ticket.hash;
    const claiming = this.#claiming.get(launch) ?? new Set<string>();
    if (claiming.has(hash)) return refused("busy");
    if (apart(this.#now(), found.ticket.issuedAt, CLAIM_WINDOW_MS)) return refused("window");
    claiming.add(hash);
    this.#claiming.set(launch, claiming);
    try {
      // Until the ticket is spent nothing has happened: what fails here is "not yet", which the
      // shim may try again (the service answers it as retryable), never a final refusal.
      let machine: LaunchMachine | undefined;
      try {
        machine = await this.#machine(space, copy);
      } catch {
        return refused("space"); // The space's machine could not be made now (its writer).
      }
      if (machine === undefined) return refused("space");
      // The claim names the process it comes from: alive, with exactly this start time.
      const alive = await this.#alive(pid, startTime);
      if (alive === undefined) return refused("check_failed");
      if (!alive) return refused("process");
      // The base the agent's environment starts from, read before anything is spent: reading it
      // may take a moment (the session layer, the registry) and never fails.
      const base = await this.#base(launch);
      const current = this.#records.get(launch);
      // The very ticket this claim read: a ticket revoked meanwhile, and replaced for the next
      // terminal, is not this one (replaceTicket).
      if (
        current?.ticket === undefined ||
        current.ticket.shimUsed ||
        current.ticket.hash !== hash
      ) {
        return refused("used");
      }
      // Spent before the claim commits: a crash between the two leaves an unclaimed intent.
      try {
        this.#records.put({ ...current, ticket: { ...current.ticket, shimUsed: true } });
      } catch {
        return refused("store"); // Not written (an atomic replace): the ticket is unspent.
      }
      let attachment: Attachment | undefined;
      const claimed = await machine.claim(launch, newClaimId(), async (intent) => {
        const credential = newCredential();
        // The record as this claim spent it: nothing else changes a launch whose claim is under
        // way (the PID check leaves it alone), so anything else sends no reply.
        const latest = this.#records.get(launch);
        if (latest?.ticket?.shimUsed !== true || latest.attachment !== undefined) {
          throw new Error("The launch's machine state changed during its claim");
        }
        // Every ticket is issued with its folder: a record without one starts nothing.
        const folder = latest.folder;
        if (folder === undefined) throw new Error("The launch has no resolved folder");
        // Durable before the reply leaves: after a restart the shim can attach with it.
        this.#records.put({
          ...latest,
          attachment: { hash: secretHash("attachment", launch, credential), pid, startTime },
        });
        const held: Attachment = { space, launch, reference: intent.reference, pid, startTime };
        attachment = held;
        const env = agentEnvironment({
          platform: this.#platform,
          base: base.env,
          baseKind: base.kind,
          instance: latest.plan.env,
          ...(latest.plan.ownHome === undefined ? {} : { ownHome: latest.plan.ownHome }),
          additions: {
            [ADDED.ticket]: ticket,
            [ADDED.space]: space,
            ...(intent.task === null ? {} : { [ADDED.task]: intent.task }),
          },
          ...(latest.plan.argv[0] === undefined ? {} : { executable: latest.plan.argv[0] }),
        });
        await send(
          {
            protocol: SHIM_PROTOCOL,
            launch: { id: launch, reference: intent.reference },
            // The folder resolved right before the launch, in the elements that name it (`-C`).
            argv: withFolder(latest.plan.argv, latest.plan.folderArgs, folder.path),
            folder: folder.path,
            check: folder.check,
            env,
            title: latest.plan.title,
            after_exit: latest.plan.afterExit,
            credential,
            exit_file: this.#records.exitPath(launch),
            ...(latest.plan.notice === undefined ? {} : { notice: latest.plan.notice }),
          },
          held,
        );
      });
      if (claimed === undefined) return refused("intent");
      if (attachment === undefined) return refused("reply_failed");
      return { kind: "claimed", intent: claimed, attachment };
    } finally {
      claiming.delete(hash);
      if (claiming.size === 0 && this.#claiming.get(launch) === claiming) {
        this.#claiming.delete(launch);
      }
    }
  }

  /** `launch.attach`: the credential, the same PID and start time, alive. */
  async attach(params: unknown): Promise<AttachOutcome> {
    if (!isObject(params)) return refused("malformed");
    const { credential, pid, start_time: startTime } = params;
    if (typeof credential !== "string" || !CREDENTIAL.test(credential)) return refused("malformed");
    if (!isPid(pid) || !isStartTime(startTime)) return refused("malformed");
    const record = this.#byCredential(credential);
    const held = record?.attachment;
    if (record === undefined || held === undefined) return refused("unknown");
    if (held.pid !== pid || held.startTime !== startTime) return refused("process");
    const alive = await this.#alive(pid, startTime);
    if (alive === undefined) return refused("check_failed");
    if (!alive) return refused("process");
    const attachment: Attachment = {
      space: record.space,
      launch: record.launch,
      reference: record.reference,
      pid,
      startTime,
    };
    return {
      kind: "attached",
      attachment,
      reply: {
        protocol: SHIM_PROTOCOL,
        launch: { id: record.launch, reference: record.reference },
      },
    };
  }

  /**
   * A report on a connection that claimed or attached: `launch.started`, `settled`, `exited`,
   * `failed`. The attachment must still be the launch's: a report after the record has gone (its
   * process ended) is refused. `ended`: the shim reported its end, and its record is gone.
   */
  async report(
    attachment: Attachment,
    method: ReportMethod,
    params: unknown,
  ): Promise<ReportOutcome> {
    const record = this.#records.get(attachment.launch);
    const held = record?.attachment;
    if (record === undefined || held === undefined) return refused("not_attached");
    if (held.pid !== attachment.pid || held.startTime !== attachment.startTime) {
      return refused("not_attached");
    }
    const p = isObject(params) ? params : {};
    let observation: Observation;
    let ends = false;
    let folderReason: ResolveReason | undefined;
    switch (method) {
      case SHIM_METHODS.started: {
        const { pid, started_at: startedAt } = p;
        if (!isPid(pid) || !isInstant(startedAt)) return refused("malformed");
        this.#records.put({ ...record, agent: { pid, startedAt } });
        observation = { kind: "evidence", evidence: { pid, pid_started_at: startedAt } };
        break;
      }
      case SHIM_METHODS.settled:
        observation = { kind: "confirmed", evidence: { folder_checked: true } };
        break;
      case SHIM_METHODS.exited: {
        const { code, signal, ran_ms: ran, settled } = p;
        if (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code))) {
          return refused("malformed");
        }
        if (signal !== null && (typeof signal !== "string" || !/^[A-Z0-9]{1,16}$/.test(signal))) {
          return refused("malformed");
        }
        if (!isInstant(ran) || typeof settled !== "boolean") return refused("malformed");
        observation = exitObservation({ spawned: true, settled, code, ran_ms: ran });
        ends = true;
        break;
      }
      case SHIM_METHODS.failed: {
        const { reason, folder } = p;
        if (!(FAILED_REASONS as readonly unknown[]).includes(reason)) return refused("malformed");
        if (folder !== undefined && (reason !== "verify" || !isFolderReason(folder))) {
          return refused("malformed");
        }
        if (folder !== undefined) folderReason = folder;
        observation = exitObservation({
          spawned: false,
          settled: false,
          code: null,
          ran_ms: 0,
          failed: reason as FailedReason,
          folder: folderReason,
        });
        ends = true;
        break;
      }
    }
    const machine = await this.#machine(record.space, record.copy);
    if (machine === undefined) return refused("space");
    let intent: LaunchIntent | undefined;
    try {
      intent = await machine.report(record.launch, observation);
    } catch {
      // Not taken now (the store refused for now, or did not answer in time): the record stays,
      // and the shim sends it again, or writes exit.json.
      return refused("store");
    }
    // The shim's process has nothing more to report: its credential and its ticket end here.
    if (ends) this.release(record.launch);
    return {
      kind: "applied",
      intent,
      ended: ends,
      ...(folderReason === undefined ? {} : { folder: folderReason }),
    };
  }

  /**
   * The live launch a ticket (`TTASKS_TICKET`) names: claimed (its attachment stored) and not yet
   * released. A ticket is its hash bound to its launch's ID, so it names only that launch. Every
   * record is hashed and compared, each in constant time. Machine state only: no space needs to be
   * open.
   */
  liveByTicket(ticket: string): LiveLaunch | undefined {
    if (typeof ticket !== "string" || !TICKET.test(ticket)) return undefined;
    const record = this.#byTicket(ticket);
    return record === undefined ? undefined : this.#live(record);
  }

  /**
   * The live launch the click preset `preset` for (`CLAUDE_CODE_SESSION_ID`): claimed and not yet
   * released, the newest click when more than one is.
   */
  liveByPreset(preset: string): LiveLaunch | undefined {
    if (typeof preset !== "string" || !SESSION_UUID.test(preset)) return undefined;
    let found: LaunchFile | undefined;
    for (const record of this.#records.list()) {
      if (record.preset !== preset || record.attachment === undefined) continue;
      if (found === undefined || record.createdAt > found.createdAt) found = record;
    }
    return found === undefined ? undefined : this.#live(found);
  }

  #live(record: LaunchFile): LiveLaunch | undefined {
    if (record.attachment === undefined) return undefined;
    return {
      launch: record.launch,
      space: record.space,
      task: record.task,
      session: sessionOf({ id: record.launch, session: record.session ?? null }),
      ...(record.app === undefined ? {} : { app: record.app }),
      ...(record.home === undefined ? {} : { home: record.home }),
      ...(record.copy === undefined ? {} : { copy: record.copy }),
    };
  }

  /**
   * Whether the launch's session runs now, for the page: its agent started and its shim's process
   * is still there. A shim that ended without a report stops counting at once, before the PID
   * check settles its launch.
   */
  running(launch: string): boolean {
    const record = this.#records.get(launch);
    const held = record?.attachment;
    if (record?.agent === undefined || held === undefined) return false;
    return this.#probe.mayRun?.(held.pid, held.startTime) ?? true;
  }

  /**
   * Whether the launch was made in the copy `copy` of its space, the one served now: a copy shows
   * only its own launches' sessions as live. None served: none. A record an earlier build wrote
   * names no copy, and counts for any.
   */
  madeIn(launch: string, copy: string | undefined): boolean {
    const record = this.#records.get(launch);
    return (
      record !== undefined &&
      copy !== undefined &&
      (record.copy === undefined || record.copy === copy)
    );
  }

  /**
   * How many of each task's launches in `space`, made in its copy `copy`, run now, for its live
   * count: a launch counts while its shim runs and no exit is on disk, so an agent that ended
   * stops counting at once, also while its shim waits for Enter.
   */
  liveSessions(space: string, copy: string | undefined): Map<string, number> {
    const counts = new Map<string, number>();
    for (const launch of this.runningIn(space, copy)) {
      const task = this.#records.get(launch)?.task;
      if (task === null || task === undefined || this.#records.readExit(launch) !== undefined) {
        continue;
      }
      counts.set(task, (counts.get(task) ?? 0) + 1);
    }
    return counts;
  }

  /** The launches of a space, made in its copy `copy`, whose session runs now (`running`). */
  runningIn(space: string, copy: string | undefined): string[] {
    return this.#records
      .list()
      .filter(
        (record) =>
          record.space === space && this.madeIn(record.launch, copy) && this.running(record.launch),
      )
      .map((record) => record.launch);
  }

  /**
   * Recovery's look at a claimed terminal launch after a restart (RecoverySteps.observe):
   * `exit.json` finalizes; a shim that is alive with its start time is pending until it re-attaches
   * and reports; one that is gone, or never got its credential, is lost. A check the OS could not
   * answer is pending, never lost. `copy`: the copy of the space whose recovery asks, when it is
   * known. A launch another copy made (a backup brought it back) is lost in this one: its session
   * writes there only.
   */
  async observe(intent: LaunchIntent, copy?: string): Promise<Observation> {
    const made = this.#records.get(intent.id) !== undefined;
    if (copy !== undefined && made && !this.madeIn(intent.id, copy)) return { kind: "lost" };
    const exit = this.#records.readExit(intent.id);
    if (exit !== undefined) return exitObservation(exit);
    const held = this.#records.get(intent.id)?.attachment;
    if (held === undefined) return { kind: "lost" };
    const alive = await this.#alive(held.pid, held.startTime);
    return alive === false ? { kind: "lost" } : { kind: "pending" };
  }

  /**
   * The PID check (every 30 s in the service, and after recovery): each attached shim
   * whose agent ended is settled by its `exit.json` (also while the shim still waits for Enter),
   * and one whose process ended without it as lost, and its record goes. A folder nothing more can
   * come from goes too: an unclaimed ticket past its window, a plan never dispatched past the
   * Prepared limit, anything older than 24 hours without a live shim. Returns how many launches it
   * settled or removed.
   *
   * It decides on each launch's record as it is when it acts, never on a list read before an
   * await: it leaves a launch whose claim is under way to the next round, judges only processes it
   * asked the OS about, and removes a record only while it is still the one it decided on.
   */
  async check(): Promise<number> {
    // The processes asked about: each attachment's PID with its start time, as the list held
    // them before the OS answered. A PID reused meanwhile names another process.
    const asked = new Set<string>();
    for (const record of this.#records.list()) {
      if (record.attachment !== undefined) asked.add(processKey(record.attachment));
    }
    const pids = [...new Set(this.#records.list().flatMap((r) => r.attachment?.pid ?? []))];
    let times: ReadonlyMap<number, string> | undefined;
    if (pids.length > 0) {
      try {
        times = await this.#probe.startTimes(pids);
      } catch {
        times = undefined; // The OS could not tell: no process is judged gone this round.
      }
    }
    let changed = 0;
    for (const launch of this.#records.list().map((r) => r.launch)) {
      if (await this.#checkOne(launch, asked, times)) changed += 1;
    }
    return changed;
  }

  /** One launch of the PID check, on its record as it is now. True when it settled or removed it. */
  async #checkOne(
    launch: string,
    asked: ReadonlySet<string>,
    times: ReadonlyMap<number, string> | undefined,
  ): Promise<boolean> {
    // A claim under way owns its launch until its reply step has run.
    if ((this.#claiming.get(launch)?.size ?? 0) > 0) return false;
    const record = this.#records.get(launch);
    if (record === undefined) return false;
    const now = this.#now();
    const held = record.attachment;
    let observation: Observation | undefined;
    if (held !== undefined) {
      const exit = this.#records.readExit(launch);
      if (exit !== undefined) {
        observation = exitObservation(exit);
      } else {
        // Gone only by the OS's answer about this very process: this PID with this start time
        // was asked about, and the PID no longer names it.
        if (times === undefined || !asked.has(processKey(held))) return false;
        if (times.get(held.pid) === held.startTime) return false;
        observation = { kind: "lost" };
      }
    } else {
      const done =
        now - record.createdAt >= FOLDER_MAX_AGE_MS ||
        (record.ticket !== undefined && apart(now, record.ticket.issuedAt, CLAIM_WINDOW_MS)) ||
        (record.ticket === undefined && apart(now, record.createdAt, PREPARED_TTL_MS));
      if (!done) return false;
      // Claimed, and its credential never stored: no reply left, so no agent started from it, but
      // the record cannot tell whether the claim committed. Lost, as after a restart. The machine
      // ignores it for a launch that was never claimed.
      if (record.ticket?.shimUsed === true) observation = { kind: "lost" };
    }
    if (observation !== undefined) {
      let machine: LaunchMachine | undefined;
      try {
        machine = await this.#machine(record.space, record.copy);
        if (machine !== undefined) await machine.report(launch, observation);
      } catch {
        return false; // The store did not answer: the next check tries again.
      }
      // A space that is not open keeps its records for its next recovery, up to 24 hours.
      if (machine === undefined && now - record.createdAt < FOLDER_MAX_AGE_MS) return false;
      // Changed meanwhile (a report, a release): the next round decides on it as it is then.
      if (this.#records.get(launch) !== record) return false;
    }
    this.release(launch);
    return true;
  }

  /**
   * Removes the launch's machine state: its credential, its ticket and its folder. From here its
   * ticket and its preset name nothing.
   */
  release(launch: string): void {
    this.#records.remove(launch);
  }
}

/** A process by its PID and its start time: one process for as long as the OS runs. */
const processKey = (p: { readonly pid: number; readonly startTime: string }): string =>
  `${String(p.pid)} ${p.startTime}`;

function refused(reason: HostRefusal): { kind: "refused"; reason: HostRefusal } {
  return { kind: "refused", reason };
}

export type { ExitFile };
