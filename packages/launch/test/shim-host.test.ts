// The shim host's rules one by one (A4 3.1, 3.6.3, 3.9.3), on the in-memory
// execution store with the real launch machine, machine state in memory, and a fake process
// table. The property test (shim.prop.test.ts) covers their combinations; the service's end-to-end
// test runs a real shim through a restart.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CLAIM_WINDOW_MS, isLaunchRef, launchRefCheck, type Route } from "../src/intents.ts";
import { LaunchMachine, type DispatchOutcome } from "../src/machine.ts";
import { ownStartTime, type ProcessProbe } from "../src/process.ts";
import { agentEnvironment, allowedNames, LIBUV_REQUIRED } from "../src/shim/environment.ts";
import { sessionOf, ShimHost, type Attachment, type ClaimOutcome } from "../src/shim/host.ts";
import {
  checkPlan,
  FOLDER_MAX_AGE_MS,
  FolderRecords,
  HELD_FILE_WAITS_MS,
  MemoryRecords,
  PLAN_MAX_BYTES,
  type ClickGiven,
  type RecordStore,
  type SpawnPlan,
} from "../src/shim/records.ts";
import { newCredential, newTicket } from "../src/shim/secrets.ts";
import {
  AFTER_EXIT_MODES,
  AGENT_ENV_NAME,
  CREDENTIAL,
  LAUNCH_ID_FORM,
  LAUNCH_REF_FORM,
  REFUSED,
  REPLY_BOUNDS,
  SHIM_METHODS,
  TICKET,
  TICKET_ALPHABET,
  type ClaimReply,
} from "../src/shim/wire.ts";
import { AFTER_EXIT } from "../src/sections.ts";
import { ExecutionRefused, LAUNCH_ID, type LaunchStore, type LaunchIntent } from "../src/store.ts";
import { CAN_HOLD_FILES, holdFile } from "@ttasks/testkit";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE, tempFolder } from "./stores.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const PLAN: SpawnPlan = {
  argv: ["/opt/agent/bin/agent", "--brief", "Read the task"],
  folder: { stored: "~/work/lumen/portal", path: "/home/mira/work/lumen/portal" },
  env: { CODEX_HOME: "/home/mira/.codex-work", FIXTURE_INSTANCE: "1" },
  title: "M-14 Fix appointment time zones",
  afterExit: "close-on-success",
};
/** The folder the dispatch step resolved for the plan's place, and its check. */
const FOLDER = {
  path: "/home/mira/work/lumen/portal",
  check: {
    dev: "2049",
    ino: "1311007",
    rootDev: "2049",
    rootIno: "1310977",
    depth: 2,
    gitRemote: "git@example.test:lumen/portal.git",
  },
};
/** What the click knows of the agent: its app, its home and the session ID it preset. */
const GIVEN: ClickGiven = {
  app: "codex",
  home: "/home/mira/.codex-work",
  preset: "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a1f",
};
const SHIM_PID = 4242;
const SHIM_START = "linux:0f0e0d0c-0b0a-4908-8706-050403020100:1234567";

/** The world: clocks, the durable store, machine state, live processes, a service life. */
let now: number;
let mono: number;
let durable: MemoryDurable;
let records: RecordStore;
let live: Map<number, string>;
let probeFails: boolean;
let machine: LaunchMachine;
let host: ShimHost;
let tickets: Map<string, string>;
let base: Record<string, string>;
/** The store refuses every transition as `unavailable` (a writer that cannot take it now). */
let storeRefuses: boolean;
/** The space's machine cannot be made (its writer does not answer). */
let machineFails: boolean;
/** While set, the OS is read at once and answers only once it resolves (a slow PowerShell). */
let probeGate: Promise<void> | undefined;

const probe: ProcessProbe = {
  startTimes: (pids) => {
    if (probeFails) return Promise.reject(new Error("no process table"));
    const read = new Map(
      pids.flatMap((pid): [number, string][] =>
        live.has(pid) ? [[pid, live.get(pid) ?? ""]] : [],
      ),
    );
    return (probeGate ?? Promise.resolve()).then(() => read);
  },
  mayRun: (pid, startTime) => live.get(pid) === startTime,
};

/** A service life: a new machine and host on the same durable store and machine state. */
function boot(): void {
  const inner = new MemoryExecutionStore(durable);
  const store: LaunchStore = {
    createIntent: (input, id) => inner.createIntent(input, id),
    transitionIntent: (id, expect, next, outcome) =>
      storeRefuses
        ? Promise.reject(new ExecutionRefused("unavailable", "The writer cannot take it now."))
        : inner.transitionIntent(id, expect, next, outcome),
    readIntent: (id) => inner.readIntent(id),
    openWork: (m) => inner.openWork(m),
  };
  machine = new LaunchMachine({
    store,
    machine: MACHINE,
    steps: {
      dispatch: (intent): Promise<DispatchOutcome> => {
        tickets.set(intent.id, host.issueTicket(intent.id, FOLDER));
        return Promise.resolve({ kind: "accepted" });
      },
    },
    recovery: {
      observe: (intent) => host.observe(intent),
      grant: () => Promise.resolve(undefined),
      replay: () => Promise.resolve({ kind: "refused" }),
    },
    now: () => now,
    elapsed: () => mono,
  });
  host = new ShimHost({
    records,
    probe,
    platform: "linux",
    machine: () => (machineFails ? Promise.reject(new Error("STORAGE_TIMEOUT")) : machine),
    environment: () => ({ kind: "service", env: base }),
    now: () => now,
  });
}

beforeEach(() => {
  now = Date.UTC(2026, 10, 14, 9, 0, 0);
  mono = 1_000;
  durable = new MemoryDurable(() => now);
  records = new MemoryRecords();
  live = new Map([[SHIM_PID, SHIM_START]]);
  probeFails = false;
  storeRefuses = false;
  machineFails = false;
  probeGate = undefined;
  tickets = new Map();
  base = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/mira",
    CODEX_HOME: "/home/mira/.codex",
    SECRET: "x",
  };
  boot();
});

const pass = (ms: number): void => {
  now += ms;
  mono += ms;
};

let requests = 0;
/** A terminal launch, clicked and dispatched: its intent and its ticket. */
async function dispatched(
  route: Route = "terminal",
  plan: SpawnPlan = PLAN,
  given: ClickGiven = GIVEN,
): Promise<{ id: string; ticket: string }> {
  requests += 1;
  const intent = await machine.open(
    {
      task: randomId("t"),
      instance: "codex-work",
      route,
      place: null,
      taskVersion: 1,
      briefHash: "b".repeat(64),
    },
    `shim-host-${String(requests).padStart(6, "0")}`,
  );
  if (route === "terminal") host.prepare(SPACE, intent, plan, given);
  await machine.dispatch(intent.id);
  return { id: intent.id, ticket: tickets.get(intent.id) ?? "" };
}

const read = async (id: string): Promise<LaunchIntent | undefined> =>
  new MemoryExecutionStore(durable).readIntent(id);

/** A claim with the shim's identity, and the replies it was sent. */
async function claim(
  ticket: string,
  identity: { pid?: number; start_time?: string } = {},
  send?: (reply: ClaimReply) => Promise<void>,
): Promise<{ outcome: ClaimOutcome; replies: ClaimReply[] }> {
  const replies: ClaimReply[] = [];
  const outcome = await host.claim(
    { ticket, role: "shim", pid: SHIM_PID, start_time: SHIM_START, ...identity },
    async (reply) => {
      replies.push(reply);
      await send?.(reply);
    },
  );
  return { outcome, replies };
}

function attachmentOf(outcome: ClaimOutcome): Attachment {
  if (outcome.kind !== "claimed") throw new Error(`refused: ${outcome.reason}`);
  return outcome.attachment;
}

describe("[A4.5.shim.claim] the one spawn claim", () => {
  test("a ticket claims once; the reply alone carries argv, the folder's check, environment and a credential", async () => {
    const { id, ticket } = await dispatched();
    expect(ticket).toMatch(TICKET);
    // Inside the reply, the claim is durable and the credential stored.
    const seen: { state?: string; claim?: string; stored?: boolean }[] = [];
    const { outcome, replies } = await claim(ticket, {}, async () => {
      const now = await read(id);
      seen.push({
        ...(now?.state === undefined ? {} : { state: now.state }),
        ...(now?.evidence.claim === undefined ? {} : { claim: now.evidence.claim }),
        stored: records.get(id)?.attachment !== undefined,
      });
    });
    expect(outcome.kind).toBe("claimed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ state: "dispatched", stored: true });
    expect(seen[0]?.claim).toMatch(/^claim-/);
    const [reply] = replies;
    expect(reply?.argv).toEqual(PLAN.argv);
    // The folder resolved at dispatch, its real path for the shim to enter (M2.09: no terminal's
    // flag decides it) and its check as plain JSON; the agent's environment holds neither.
    expect(reply?.folder).toBe(FOLDER.path);
    expect(reply?.check).toEqual(FOLDER.check);
    expect(JSON.stringify(reply?.env)).not.toContain(FOLDER.path);
    expect(JSON.stringify(reply?.env)).not.toContain(FOLDER.check.ino);
    expect(records.get(id)?.folder).toEqual(FOLDER);
    expect(reply?.after_exit).toBe("close-on-success");
    expect(reply?.credential).toMatch(CREDENTIAL);
    expect(reply?.env).toMatchObject({
      CODEX_HOME: "/home/mira/.codex-work",
      TTASKS_TICKET: ticket,
    });
    expect(reply?.env).not.toHaveProperty("SECRET");
    // The claim's evidence is its own random ID, never a secret.
    const claimed = await read(id);
    expect(claimed?.evidence.claim).not.toContain(ticket);
    expect(claimed?.evidence.claim).not.toContain(reply?.credential ?? "-");
    // Only hashes are kept.
    const kept = JSON.stringify(records.get(id));
    expect(kept).not.toContain(ticket);
    expect(kept).not.toContain(reply?.credential ?? "-");

    // A second claim with it, from the same live shim: refused, and no reply.
    const again = await claim(ticket);
    expect(again.outcome).toEqual({ kind: "refused", reason: "used" });
    expect(again.replies).toEqual([]);
    expect((await read(id))?.evidence.claim).toBe(claimed?.evidence.claim);
  });

  test("a claim after the ticket's window is refused, live and after a restart", async () => {
    const late = await dispatched();
    pass(CLAIM_WINDOW_MS);
    expect((await claim(late.ticket)).outcome).toEqual({ kind: "refused", reason: "window" });

    // After a restart the window is judged on the wall clock, in either direction.
    const other = await dispatched();
    boot();
    now -= CLAIM_WINDOW_MS + 1;
    const refused = await claim(other.ticket);
    expect(refused.outcome.kind).toBe("refused");
    expect(refused.replies).toEqual([]);
    expect((await read(other.id))?.evidence.claim).toBeUndefined();
  });

  test("a ticket claims only its own launch, and a launch that cannot be claimed refuses it", async () => {
    const a = await dispatched();
    const b = await dispatched();
    // B's machine state is given A's ticket hash: A's ticket still names A only.
    const recordA = records.get(a.id);
    const recordB = records.get(b.id);
    if (recordA?.ticket === undefined || recordB?.ticket === undefined)
      throw new Error("no ticket");
    records.put({ ...recordB, ticket: { ...recordA.ticket } });
    const claimed = await claim(a.ticket);
    expect(claimed.outcome.kind === "claimed" && claimed.outcome.intent.id).toBe(a.id);
    expect((await read(b.id))?.evidence.claim).toBeUndefined();
    // B's own ticket no longer matches B's record, so it claims nothing.
    expect((await claim(b.ticket)).outcome).toEqual({ kind: "refused", reason: "unknown" });

    // A launch that failed is not claimable: its ticket is refused by the machine.
    const c = await dispatched();
    pass(CLAIM_WINDOW_MS - 1);
    await machine.report(c.id, { kind: "failed", reason: "refused" });
    pass(-(CLAIM_WINDOW_MS - 1));
    const final = await claim(c.ticket);
    expect(final.outcome).toEqual({ kind: "refused", reason: "intent" });
    expect(final.replies).toEqual([]);
    // A ticket nobody issued.
    expect((await claim(newTicket())).outcome).toEqual({ kind: "refused", reason: "unknown" });
  });

  test("a claim from a process other than the one it names is refused, and leaves the ticket", async () => {
    const { id, ticket } = await dispatched();
    // Another start time: a reused PID or another process.
    expect(
      (await claim(ticket, { start_time: "linux:0f0e0d0c-0b0a-4908-8706-050403020100:1" })).outcome,
    ).toEqual({ kind: "refused", reason: "process" });
    // A PID with no process.
    expect((await claim(ticket, { pid: 999 })).outcome).toEqual({
      kind: "refused",
      reason: "process",
    });
    // A process table the OS could not read: never taken as either.
    probeFails = true;
    expect((await claim(ticket)).outcome).toEqual({ kind: "refused", reason: "check_failed" });
    probeFails = false;
    expect((await read(id))?.evidence.claim).toBeUndefined();
    // The shim the ticket was given to still claims.
    expect((await claim(ticket)).outcome.kind).toBe("claimed");
  });

  test("a credential is never a ticket, and a malformed claim is refused unread", async () => {
    const { ticket } = await dispatched();
    const { outcome, replies } = await claim(ticket);
    const credential = replies[0]?.credential ?? "";
    attachmentOf(outcome);
    expect((await claim(credential)).outcome).toEqual({ kind: "refused", reason: "malformed" });
    expect(newCredential()).not.toMatch(TICKET);
    expect(newTicket()).not.toMatch(CREDENTIAL);
    for (const params of [
      undefined,
      {},
      { ticket, role: "bridge", pid: SHIM_PID, start_time: SHIM_START },
      { ticket, role: "shim", pid: -1, start_time: SHIM_START },
      { ticket, role: "shim", pid: SHIM_PID, start_time: "yesterday" },
      { ticket: ticket.toLowerCase(), role: "shim", pid: SHIM_PID, start_time: SHIM_START },
    ]) {
      expect((await host.claim(params, () => Promise.resolve())).kind).toBe("refused");
    }
  });

  test("a space whose machine cannot be made yet refuses for now and leaves the ticket unspent", async () => {
    const { id, ticket } = await dispatched();
    machineFails = true;
    expect((await claim(ticket)).outcome).toEqual({ kind: "refused", reason: "space" });
    expect(records.get(id)?.ticket?.shimUsed).toBe(false);
    machineFails = false;
    expect((await claim(ticket)).outcome.kind).toBe("claimed");
  });

  test("a reply that never reached its shim starts nothing: the claim stands, the PID check settles it", async () => {
    const { id, ticket } = await dispatched();
    const { outcome } = await claim(ticket, {}, () =>
      Promise.reject(new Error("connection closed")),
    );
    // The machine keeps the claim: whether the reply arrived it cannot tell.
    expect(outcome.kind).toBe("claimed");
    expect((await read(id))?.evidence.claim).toBeDefined();
    // The shim, with no reply, gives up and ends: lost, and its machine state goes.
    live.delete(SHIM_PID);
    expect(await host.check()).toBe(1);
    expect(await read(id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(records.get(id)).toBeUndefined();
  });
});

describe("[A4.5.shim.attach] attachment, reports, recovery and the PID check", () => {
  test("an attach needs the credential, the same PID and start time and a live process; its reply starts nothing", async () => {
    const { id, ticket } = await dispatched();
    const { replies } = await claim(ticket);
    const credential = replies[0]?.credential ?? "";
    const attach = (params: Record<string, unknown>) =>
      host.attach({ credential, pid: SHIM_PID, start_time: SHIM_START, ...params });

    const attached = await attach({});
    expect(attached.kind).toBe("attached");
    if (attached.kind !== "attached") return;
    expect(Object.keys(attached.reply).sort()).toEqual(["launch", "protocol"]);
    expect(attached.attachment).toMatchObject({ launch: id, pid: SHIM_PID });

    expect(await attach({ credential: newCredential() })).toEqual({
      kind: "refused",
      reason: "unknown",
    });
    expect(await attach({ pid: SHIM_PID + 1 })).toEqual({ kind: "refused", reason: "process" });
    expect(await attach({ start_time: "windows:1" })).toEqual({
      kind: "refused",
      reason: "process",
    });
    expect(await attach({ credential: ticket })).toEqual({ kind: "refused", reason: "malformed" });
    // The PID now names another process: a reused PID is never the shim.
    live.set(SHIM_PID, "linux:0f0e0d0c-0b0a-4908-8706-050403020100:99");
    expect(await attach({})).toEqual({ kind: "refused", reason: "process" });
    // An attachment never claims: the claim with the ticket is still refused.
    live.set(SHIM_PID, SHIM_START);
    expect((await claim(ticket)).outcome).toEqual({ kind: "refused", reason: "used" });
  });

  test("reports apply to the attached launch, and its exit ends the attachment", async () => {
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now });
    expect((await read(id))?.evidence).toMatchObject({ pid: 5151, pid_started_at: now });
    await host.report(attachment, SHIM_METHODS.settled, {});
    expect(await read(id)).toMatchObject({
      state: "confirmed",
      evidence: { folder_checked: true },
    });
    const exited = await host.report(attachment, SHIM_METHODS.exited, {
      code: 3,
      signal: null,
      ran_ms: 60_000,
      settled: true,
    });
    expect(exited).toMatchObject({ kind: "applied", ended: true });
    expect(await read(id)).toMatchObject({ state: "confirmed", evidence: { exit_code: 3 } });
    expect(records.get(id)).toBeUndefined();
    expect(await host.report(attachment, SHIM_METHODS.settled, {})).toEqual({
      kind: "refused",
      reason: "not_attached",
    });
  });

  test("exit.json is collected while its shim still waits for Enter, a Confirmed launch's too", async () => {
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await host.report(attachment, SHIM_METHODS.settled, {});
    expect((await read(id))?.state).toBe("confirmed");
    // The service is down at the agent's end: the shim writes exit.json and waits for Enter,
    // alive. A new service recovers (a Confirmed launch is not open work) and checks.
    (records as MemoryRecords).exits.set(id, {
      format: 1,
      launch: id,
      spawned: true,
      settled: true,
      code: 7,
      signal: null,
      ran_ms: 90_000,
    });
    boot();
    await machine.recover();
    expect(await host.check()).toBe(1);
    expect(await read(id)).toMatchObject({ state: "confirmed", evidence: { exit_code: 7 } });
    expect(records.get(id)).toBeUndefined();
  });

  test("an exit the store cannot take now keeps the launch's record, and the shim's next try applies it", async () => {
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    const exit = { code: 0, signal: null, ran_ms: 60_000, settled: true };
    storeRefuses = true;
    expect(await host.report(attachment, SHIM_METHODS.exited, exit)).toEqual({
      kind: "refused",
      reason: "store",
    });
    expect((await read(id))?.state).toBe("dispatched");
    expect(records.get(id)?.attachment).toBeDefined();
    // So the PID check, once the shim has gone, keeps it too while the store cannot take it.
    live.delete(SHIM_PID);
    expect(await host.check()).toBe(0);
    expect(records.get(id)).toBeDefined();
    live.set(SHIM_PID, SHIM_START);
    storeRefuses = false;
    expect(await host.report(attachment, SHIM_METHODS.exited, exit)).toMatchObject({
      kind: "applied",
      ended: true,
    });
    expect(await read(id)).toMatchObject({ state: "confirmed", evidence: { exit_code: 0 } });
    expect(records.get(id)).toBeUndefined();
  });

  test("an agent that ends within 3 s fails its launch, and a failed verify starts none", async () => {
    const early = await dispatched();
    const a = attachmentOf((await claim(early.ticket)).outcome);
    await host.report(a, SHIM_METHODS.exited, {
      code: 1,
      signal: null,
      ran_ms: 400,
      settled: false,
    });
    expect(await read(early.id)).toMatchObject({
      state: "failed",
      reason: "agent_exited",
      evidence: { exit_code: 1 },
    });

    const bad = await dispatched();
    const b = attachmentOf((await claim(bad.ticket)).outcome);
    expect((await host.report(b, SHIM_METHODS.failed, { reason: "nonsense" })).kind).toBe(
      "refused",
    );
    // A folder check's reason is one of places.ts's words, and only with a failed verify.
    for (const params of [
      { reason: "verify", folder: "/home/mira/elsewhere" },
      { reason: "spawn", folder: "folder_changed" },
    ]) {
      expect((await host.report(b, SHIM_METHODS.failed, params)).kind).toBe("refused");
    }
    expect(
      await host.report(b, SHIM_METHODS.failed, { reason: "verify", folder: "folder_changed" }),
    ).toMatchObject({ kind: "applied", ended: true, folder: "folder_changed" });
    // The launch records the folder's own reason, so the task says why.
    expect(await read(bad.id)).toMatchObject({ state: "failed", reason: "folder_changed" });
    // A Windows NTSTATUS exit code is no count: the exit is recorded without it.
    const ntstatus = await dispatched();
    const c = attachmentOf((await claim(ntstatus.ticket)).outcome);
    await host.report(c, SHIM_METHODS.exited, {
      code: 3221225786,
      signal: null,
      ran_ms: 9_000,
      settled: true,
    });
    const after = await read(ntstatus.id);
    expect(after?.state).toBe("confirmed");
    expect(after?.evidence.exit_code).toBeUndefined();
  });

  test("recovery after a restart: exit.json finalizes, a live shim is pending, a gone one is lost", async () => {
    const withExit = await dispatched();
    attachmentOf((await claim(withExit.ticket)).outcome);
    const alive = await dispatched();
    live.set(SHIM_PID + 1, SHIM_START);
    const aliveAttachment = attachmentOf(
      (await claim(alive.ticket, { pid: SHIM_PID + 1 })).outcome,
    );
    const gone = await dispatched();
    live.set(SHIM_PID + 2, SHIM_START);
    attachmentOf((await claim(gone.ticket, { pid: SHIM_PID + 2 })).outcome);
    const unfit = await dispatched();
    live.set(SHIM_PID + 3, SHIM_START);
    attachmentOf((await claim(unfit.ticket, { pid: SHIM_PID + 3 })).outcome);

    // The service stops. One shim's agent ends meanwhile and its shim writes exit.json; another
    // shim dies without a word; a third finds its folder gone and starts no agent.
    (records as MemoryRecords).exits.set(withExit.id, {
      format: 1,
      launch: withExit.id,
      spawned: true,
      settled: true,
      code: 0,
      signal: null,
      ran_ms: 90_000,
    });
    (records as MemoryRecords).exits.set(unfit.id, {
      format: 1,
      launch: unfit.id,
      spawned: false,
      settled: false,
      code: null,
      signal: null,
      ran_ms: 0,
      failed: "verify",
      folder: "path_missing",
    });
    live.delete(SHIM_PID);
    live.delete(SHIM_PID + 2);
    live.delete(SHIM_PID + 3);
    // Down longer than the claim window: no shim can claim or report meanwhile.
    pass(15 * 60_000 + CLAIM_WINDOW_MS);
    boot();
    await machine.recover();
    expect(await read(withExit.id)).toMatchObject({
      state: "confirmed",
      evidence: { exit_code: 0 },
    });
    expect(await read(alive.id)).toMatchObject({ state: "dispatched" });
    expect(await read(gone.id)).toMatchObject({ state: "unknown", reason: "lost" });
    // The folder's own reason, not only that the shim's check failed.
    expect(await read(unfit.id)).toMatchObject({ state: "failed", reason: "path_missing" });
    await host.check();
    expect(records.get(withExit.id)).toBeUndefined();
    expect(records.get(gone.id)).toBeUndefined();

    // The live shim re-attaches after both windows and reports; it never claims again.
    expect((await claim(alive.ticket, { pid: SHIM_PID + 1 })).outcome.kind).toBe("refused");
    const re = await host.attach({
      credential: "x".repeat(21) + "A",
      pid: SHIM_PID + 1,
      start_time: SHIM_START,
    });
    expect(re.kind).toBe("refused");
    await host.report(aliveAttachment, SHIM_METHODS.exited, {
      code: 0,
      signal: null,
      ran_ms: 5_000,
      settled: true,
    });
    expect(await read(alive.id)).toMatchObject({ state: "confirmed", evidence: { exit_code: 0 } });
  });

  test("the PID check: a shim gone without a report is lost; a check the OS cannot answer decides nothing; folders nothing more can come from go", async () => {
    const { id, ticket } = await dispatched();
    attachmentOf((await claim(ticket)).outcome);
    live.delete(SHIM_PID);
    probeFails = true;
    expect(await host.check()).toBe(0);
    expect((await read(id))?.state).toBe("dispatched");
    probeFails = false;
    expect(await host.check()).toBe(1);
    expect(await read(id)).toMatchObject({ state: "unknown", reason: "lost" });

    // An unclaimed ticket past its window, and a plan never dispatched past the Prepared limit.
    const unclaimed = await dispatched();
    pass(CLAIM_WINDOW_MS);
    expect(records.get(unclaimed.id)).toBeDefined();
    expect(await host.check()).toBe(1);
    expect(records.get(unclaimed.id)).toBeUndefined();
  });

  test("a PID reused while the check waits for the OS names another process: its new claim stays attached", async () => {
    const first = await dispatched();
    attachmentOf((await claim(first.ticket)).outcome);
    // The check reads the OS now and answers late.
    let answer!: () => void;
    probeGate = new Promise((resolve) => {
      answer = resolve;
    });
    const checking = host.check();
    probeGate = undefined;
    // Meanwhile the first shim ends, and its PID goes to the next launch's shim, which claims.
    const reused = "linux:0f0e0d0c-0b0a-4908-8706-050403020100:7654321";
    live.set(SHIM_PID, reused);
    const next = await dispatched();
    const attachment = attachmentOf((await claim(next.ticket, { start_time: reused })).outcome);
    answer();
    await checking;
    // The old answer was about the first shim's process, not this one.
    expect(records.get(next.id)?.attachment?.startTime).toBe(reused);
    expect((await read(next.id))?.state).toBe("dispatched");
    expect(
      (await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now })).kind,
    ).toBe("applied");
    // The next round judges the first shim on an answer about its own process: gone.
    expect(await host.check()).toBe(1);
    expect(await read(first.id)).toMatchObject({ state: "unknown", reason: "lost" });
    expect(records.get(next.id)?.attachment).toBeDefined();
  });

  test("the PID check never acts on a launch whose claim is under way: the claim keeps its attachment", async () => {
    const { id, ticket } = await dispatched();
    // The check runs between the ticket's spending and the credential's storing, with the wall
    // clock past the ticket's window: a step of the clock, or a store commit that straddles the
    // window's end. The machine's own window, on its monotonic clock, is still open.
    let checking: Promise<number> | undefined;
    (records as MemoryRecords).beforePut = (file) => {
      if (checking !== undefined || file.launch !== id) return;
      if (file.ticket?.shimUsed !== true || file.attachment !== undefined) return;
      queueMicrotask(() => {
        now += CLAIM_WINDOW_MS + 1_000;
        checking = host.check();
      });
    };
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await checking;
    // The claim stands and its shim stays attached: nothing was lost.
    expect(await read(id)).toMatchObject({ state: "dispatched" });
    expect(records.get(id)?.attachment?.pid).toBe(SHIM_PID);
    expect(
      (await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now })).kind,
    ).toBe("applied");
  });
});

describe("[A4.5.shim.environment] the agent's environment", () => {
  test("an allow-list of the base, the home variables removed first, the instance's env, then A4's additions", () => {
    const env = agentEnvironment({
      platform: "linux",
      base: {
        PATH: "/usr/bin",
        HOME: "/home/mira",
        LC_TIME: "nl_NL.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1000",
        CODEX_HOME: "/inherited/codex",
        CLAUDE_CONFIG_DIR: "/inherited/claude",
        TTASKS_HOME: "/inherited/tasks",
        CLAUDECODE: "1",
        NODE_OPTIONS: "--inspect",
        AWS_SECRET_ACCESS_KEY: "fixture",
        UNSET: undefined,
      },
      instance: {
        CODEX_HOME: "/home/mira/.codex-work",
        FIXTURE_INSTANCE: "1",
        TTASKS_TASK: "nope",
      },
      additions: { TTASKS_TICKET: "T".repeat(24), TTASKS_TASK: "t_x", TTASKS_SPACE: SPACE },
    });
    expect(env).toEqual({
      CODEX_HOME: "/home/mira/.codex-work",
      FIXTURE_INSTANCE: "1",
      HOME: "/home/mira",
      TTASKS_SPACE: SPACE,
      TTASKS_TASK: "t_x",
      TTASKS_TICKET: "T".repeat(24),
      LC_TIME: "nl_NL.UTF-8",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  test("Windows names are one name whatever their case, and each layer replaces the one before", () => {
    const env = agentEnvironment({
      platform: "win32",
      base: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", codex_home: "C:\\x", ComSpec: "cmd" },
      instance: { PATH: "C:\\tools", Codex_Home: "C:\\Users\\mira\\.codex-work" },
      additions: {},
    });
    // Every name libuv would fill from the shim that no layer gave is named, empty.
    const empty = Object.fromEntries(
      LIBUV_REQUIRED.filter((n) => n !== "PATH" && n !== "SYSTEMROOT").map((n) => [n, ""]),
    );
    expect(env).toEqual({
      ...empty,
      Codex_Home: "C:\\Users\\mira\\.codex-work",
      ComSpec: "cmd",
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
    });
    // And each is on the list, so the agent gets the base's value when it has one.
    const listed = allowedNames("win32").names.map((n) => n.toUpperCase());
    for (const name of LIBUV_REQUIRED) expect(listed, name).toContain(name);
  });

  test.runIf(process.platform === "win32")(
    "a real Windows child gets a libuv name the base lacks empty, never its parent's value",
    async () => {
      const real = (name: string): [string, string][] => {
        const found = Object.entries(process.env).find(([n]) => n.toUpperCase() === name);
        return found?.[1] === undefined ? [] : [[found[0], found[1]]];
      };
      // The base has what Node needs to start, and no HOMEDRIVE; this process, the parent as the
      // shim is, has one.
      const env = agentEnvironment({
        platform: "win32",
        base: Object.fromEntries(LIBUV_REQUIRED.filter((n) => n !== "HOMEDRIVE").flatMap(real)),
        instance: {},
        additions: {},
      });
      const parent = process.env["HOMEDRIVE"];
      process.env["HOMEDRIVE"] = "Z:";
      try {
        const seen = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["-e", "process.stdout.write(JSON.stringify(process.env.HOMEDRIVE ?? null))"],
            { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
          );
          let out = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            out += chunk;
          });
          child.once("error", reject);
          child.once("close", () => {
            resolve(out);
          });
        });
        expect(["", null]).toContain(JSON.parse(seen));
      } finally {
        if (parent === undefined) delete process.env["HOMEDRIVE"];
        else process.env["HOMEDRIVE"] = parent;
      }
    },
  );

  test("the wire's after_exit modes are A4 3.6.1's", () => {
    expect([...AFTER_EXIT_MODES]).toEqual([...AFTER_EXIT]);
    expect(REFUSED).toBe("launch_refused");
  });

  test("[A4.5.shim.reply] the forms the shim reads the reply with are the store's, and the service sends only what they accept", () => {
    expect(LAUNCH_ID_FORM.source).toBe(LAUNCH_ID.source);
    for (let i = 0; i < 200; i += 1) {
      const symbols = Array.from({ length: 4 }, () =>
        TICKET_ALPHABET.charAt(Math.floor(Math.random() * 32)),
      ).join("");
      const reference = `L${symbols}${launchRefCheck(symbols) ?? ""}`;
      expect(isLaunchRef(reference)).toBe(true);
      expect(LAUNCH_REF_FORM.test(reference), reference).toBe(true);
    }
    // The base's names that the shim would refuse, and values past the bound, never reach the
    // agent's environment; the plan's instance env is bounded the same way.
    const env = agentEnvironment({
      platform: "linux",
      base: {
        PATH: "/usr/bin",
        "XDG_A.B": "x",
        XDG_LONG: "x".repeat(REPLY_BOUNDS.value + 1),
        XDG_OK: "y",
      },
      instance: {},
      additions: {},
    });
    expect(env).toEqual({ PATH: "/usr/bin", XDG_OK: "y" });
    for (const name of Object.keys(env)) expect(AGENT_ENV_NAME.test(name)).toBe(true);
    const many = Object.fromEntries(
      Array.from({ length: REPLY_BOUNDS.env / 2 + 1 }, (_, i) => [`V${String(i)}`, "1"]),
    );
    expect(checkPlan({ ...PLAN, env: many })).toBeUndefined();
    expect(checkPlan({ ...PLAN, title: "t".repeat(REPLY_BOUNDS.title + 1) })).toBeUndefined();
  });
});

describe("[A4.5.shim.attach] machine state in folders", () => {
  const temps: { remove: () => void }[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) t.remove();
  });

  test.skipIf(!CAN_HOLD_FILES)(
    "a launch file held for a moment as the service starts is read again and kept; one held past the waits, or one no wait can open, is left out with its ID and error code",
    async () => {
      const temp = tempFolder();
      temps.push(temp);
      const root = join(temp.path, "launch");
      records = new FolderRecords(root);
      boot();
      const moment = await dispatched();
      const { replies } = await claim(moment.ticket);
      const credential = replies[0]?.credential ?? "";
      const stuck = await dispatched();
      await claim(stuck.ticket);
      const folder = await dispatched();
      await claim(folder.ticket);
      const fileOf = (id: string) => join(root, id, "launch.json");
      // Each hold is released however the test ends, from the moment it is taken.
      const holds: { release(): void }[] = [];
      try {
        // A scanner holds two files as the service starts; a folder stands in place of a third.
        const momentHold = holdFile(fileOf(moment.id));
        holds.push(momentHold);
        holds.push(holdFile(fileOf(stuck.id)));
        rmSync(fileOf(folder.id));
        mkdirSync(fileOf(folder.id));
        const waits: number[] = [];
        const left: [string, string][] = [];
        records = new FolderRecords(root, {
          wait: (ms) => {
            waits.push(ms);
            if (waits.length === 2) momentHold.release();
          },
          unreadable: (launch, code) => left.push([launch, code]),
        });
        boot();
        expect(records.list().map((r) => r.launch)).toEqual([moment.id]);
        // Every wait was taken while one file was still held, and nothing waits after them.
        expect(waits).toEqual([...HELD_FILE_WAITS_MS]);
        expect(left.map(([launch]) => launch).sort()).toEqual([stuck.id, folder.id].sort());
        expect(new Map(left).get(folder.id)).toBe("EISDIR");
        expect(["EBUSY", "EACCES", "EPERM"]).toContain(new Map(left).get(stuck.id));
        // From here the records in memory decide: the launch left out is no launch, at once.
        expect(host.liveByTicket(moment.ticket)?.launch).toBe(moment.id);
        expect(host.liveByTicket(stuck.ticket)).toBeUndefined();
        expect(
          await host.attach({ credential, pid: SHIM_PID, start_time: SHIM_START }),
        ).toMatchObject({ kind: "attached" });
      } finally {
        for (const hold of holds) hold.release();
      }
      // A file no wait can open is left out without one.
      const waits: number[] = [];
      const again = new FolderRecords(root, { wait: (ms) => waits.push(ms) });
      expect(waits).toEqual([]);
      expect(
        again
          .list()
          .map((r) => r.launch)
          .sort(),
      ).toEqual([moment.id, stuck.id].sort());
    },
  );

  test("user-only files, written whole, read back by a new service, a damaged one left out", async () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    const { id, ticket } = await dispatched();
    const { replies } = await claim(ticket);
    const file = join(root, id, "launch.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(ticket);
    expect(text).not.toContain(replies[0]?.credential ?? "-");
    if (process.platform !== "win32") {
      expect(statSync(join(root, id)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    // A damaged file, and a folder that is no launch's, are left out.
    const damaged = randomId("la");
    mkdirSync(join(root, damaged));
    writeFileSync(join(root, damaged, "launch.json"), "{not json");
    mkdirSync(join(root, "elsewhere"));
    const again = new FolderRecords(root);
    expect(again.list().map((r) => r.launch)).toEqual([id]);
    expect(again.get(id)?.attachment?.pid).toBe(SHIM_PID);
    // The plan's folder and the folder resolved at dispatch, with its check, come back as written.
    expect(again.get(id)?.plan.folder).toEqual(PLAN.folder);
    expect(again.get(id)?.folder).toEqual(FOLDER);
    // exit.json is read only when it names its own launch.
    writeFileSync(
      again.exitPath(id),
      JSON.stringify({
        format: 1,
        launch: damaged,
        spawned: true,
        settled: true,
        code: 0,
        signal: null,
        ran_ms: 1,
      }),
    );
    expect(again.readExit(id)).toBeUndefined();
    writeFileSync(
      again.exitPath(id),
      JSON.stringify({
        format: 1,
        launch: id,
        spawned: true,
        settled: false,
        code: 1,
        signal: null,
        ran_ms: 10,
      }),
    );
    expect(again.readExit(id)).toMatchObject({ code: 1, settled: false });
    // A failed folder check's reason is kept when it is one of places.ts's words, never else.
    const failedExit = { format: 1, launch: id, spawned: false, settled: false, code: null };
    const withFolder = (folder: unknown): void => {
      writeFileSync(
        again.exitPath(id),
        JSON.stringify({ ...failedExit, signal: null, ran_ms: 0, failed: "verify", folder }),
      );
    };
    withFolder("folder_changed");
    expect(again.readExit(id)).toMatchObject({ failed: "verify", folder: "folder_changed" });
    withFolder("/home/mira/elsewhere");
    expect(again.readExit(id)).toBeUndefined();
    again.remove(id);
    expect(again.list()).toEqual([]);
  });

  test("a plan names its folder as stored and as this machine opens it, or none", () => {
    expect(checkPlan({ ...PLAN, folder: null })?.folder).toBeNull();
    const windows = { stored: "~\\code\\portal", path: "C:\\Users\\mira\\code\\portal" };
    expect(checkPlan({ ...PLAN, folder: windows })?.folder).toEqual(windows);
    for (const folder of [
      undefined,
      "/home/mira/work/lumen/portal",
      { stored: "~/work/portal" },
      { stored: "", path: "/home/mira/work/portal" },
      { stored: "~/work/portal", path: "/home/mira/work\u0007portal" },
      { stored: "~/work/portal", path: "/home/mira/work/portal", extra: true },
      { root: "work", path: "lumen" },
    ]) {
      expect(checkPlan({ ...PLAN, folder }), JSON.stringify(folder)).toBeUndefined();
    }
  });

  test("after an update, a launch the build before folders wrote is read back with the folder its terminal started in", async () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    const { id, ticket } = await dispatched();
    await claim(ticket);
    const file = join(root, id, "launch.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
      plan: Record<string, unknown>;
    };
    // That build's plan held a place where it now holds a folder.
    const older = (place: unknown, resolved: boolean): string => {
      const plan: Record<string, unknown> = { ...written.plan, place };
      delete plan["folder"];
      const file: Record<string, unknown> = { ...written, plan };
      if (resolved) file["folder"] = FOLDER;
      else delete file["folder"];
      return JSON.stringify(file);
    };
    writeFileSync(file, older({ root: "work", path: "lumen/portal" }, true));
    const placed = new FolderRecords(root).get(id);
    expect(placed?.plan.folder).toEqual({ stored: FOLDER.path, path: FOLDER.path });
    expect(placed?.folder).toEqual(FOLDER);
    expect(placed?.attachment?.pid).toBe(SHIM_PID);
    writeFileSync(file, older(null, true));
    expect(new FolderRecords(root).get(id)?.plan.folder).toBeNull();
    // A place never dispatched names no folder here: that launch is left out and never starts.
    writeFileSync(file, older({ root: "work", path: "lumen/portal" }, false));
    expect(new FolderRecords(root).get(id)).toBeUndefined();
  });

  test("a plan too large for a launch file is refused at the click; every plan taken is read back after a restart", async () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    const envOf = (count: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`FIXTURE_${String(i)}`, "v".repeat(32_000)]),
      );
    // 35 values of 32,000 characters each are allowed one by one, not together.
    expect(checkPlan({ ...PLAN, env: envOf(35) })).toBeUndefined();
    const intent = await machine.open(
      {
        task: randomId("t"),
        instance: "codex-work",
        route: "terminal",
        place: null,
        taskVersion: 1,
        briefHash: "b".repeat(64),
      },
      "shim-host-too-large",
    );
    expect(() => {
      host.prepare(SPACE, intent, { ...PLAN, env: envOf(35) });
    }).toThrow();
    // The largest plan taken, claimed: its launch file is read back whole.
    const largest = { ...PLAN, env: envOf(Math.floor(PLAN_MAX_BYTES / 32_020) - 1) };
    expect(checkPlan(largest)).toBeDefined();
    host.prepare(SPACE, intent, largest);
    await machine.dispatch(intent.id);
    attachmentOf((await claim(tickets.get(intent.id) ?? "")).outcome);
    const again = new FolderRecords(root);
    expect(again.get(intent.id)?.attachment?.pid).toBe(SHIM_PID);
    expect(Object.keys(again.get(intent.id)?.plan.env ?? {})).toHaveLength(
      Object.keys(largest.env).length,
    );
  });
});

describe("[A4.5.terminal.acceptance] a direct terminal's ticket is revoked before the next terminal starts", () => {
  test("a replaced ticket claims nothing and its replacement claims once; a spent ticket is never replaced", async () => {
    const { id, ticket } = await dispatched();
    expect(host.ticketSpent(id)).toBe(false);
    const next = host.replaceTicket(id) ?? "";
    expect(next).toMatch(TICKET);
    expect(next).not.toBe(ticket);
    expect((await claim(ticket)).outcome).toEqual({ kind: "refused", reason: "unknown" });
    expect((await claim(next)).outcome.kind).toBe("claimed");
    expect(host.ticketSpent(id)).toBe(true);
    // A claim came: nothing is revoked, and the step counts the terminal as Dispatched.
    expect(host.replaceTicket(id)).toBeUndefined();
  });

  test("a claim already reading the old ticket when it is replaced is refused and spends nothing", async () => {
    const { id, ticket } = await dispatched();
    let release!: () => void;
    probeGate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = claim(ticket);
    // The claim waits for the OS's answer; meanwhile the terminal died and its ticket is replaced.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = host.replaceTicket(id) ?? "";
    release();
    probeGate = undefined;
    expect((await pending).outcome).toEqual({ kind: "refused", reason: "used" });
    expect(host.ticketSpent(id)).toBe(false);
    expect((await claim(next)).outcome.kind).toBe("claimed");
  });

  test("the next terminal's claim is never refused as busy while the revoked ticket's claim is still under way", async () => {
    const { id, ticket } = await dispatched();
    let release!: () => void;
    probeGate = new Promise((resolve) => {
      release = resolve;
    });
    // The first window's shim claims and waits for the OS; then the window dies, its ticket is
    // replaced, and the next terminal's shim claims at once.
    const pending = claim(ticket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    probeGate = undefined;
    const next = host.replaceTicket(id) ?? "";
    const second = await claim(next);
    expect(second.outcome.kind).toBe("claimed");
    expect(second.replies).toHaveLength(1);
    release();
    expect((await pending).outcome).toEqual({ kind: "refused", reason: "used" });
    expect((await pending).replies).toHaveLength(0);
  });
});

describe("[A4.5.environment.scrub] the claim's reply builds the agent's environment from the base", () => {
  test("a user base is taken whole and scrubbed; the base is the claiming launch's own; no reply names a shell; no secret of the product", async () => {
    base = {
      PATH: "/home/mira/.local/bin:/usr/bin",
      SHELL: "/usr/bin/zsh",
      GOPATH: "/home/mira/go",
      CLAUDECODE: "1",
      TTASKS_HOME: "/k",
    };
    // A via_login_shell launch's own base, as its dispatch step took it in the task's folder: the
    // profile re-exported what A4 scrubs and set a home variable, and the scrub still applies.
    const own = {
      ...base,
      FROM_FOLDER: "1",
      NODE_OPTIONS: "--require /tmp/profile.js",
      CODEX_HOME: "/home/mira/.codex-profile",
    };
    const asked: string[] = [];
    let loginLaunch = "";
    // The base is the person's own: a host on the same world that reads it as such.
    host = new ShimHost({
      records,
      probe,
      platform: "linux",
      machine: () => machine,
      environment: (launch) => {
        asked.push(launch);
        return Promise.resolve({ kind: "user", env: launch === loginLaunch ? own : base });
      },
      now: () => now,
    });
    const login = await dispatched("terminal", { ...PLAN, loginShell: true });
    loginLaunch = login.id;
    const { replies, outcome } = await claim(login.ticket);
    expect(outcome.kind).toBe("claimed");
    expect(asked).toEqual([login.id]);
    const [reply] = replies;
    expect(reply).not.toHaveProperty("login_shell");
    expect(reply?.argv).toEqual(PLAN.argv);
    expect(reply?.env).toMatchObject({ GOPATH: "/home/mira/go", FROM_FOLDER: "1" });
    for (const name of ["CLAUDECODE", "TTASKS_HOME", "NODE_OPTIONS"]) {
      expect(reply?.env, name).not.toHaveProperty(name);
    }
    // The home is the instance's, never the profile's.
    expect(reply?.env["CODEX_HOME"]).toBe(PLAN.env["CODEX_HOME"]);
    expect(reply?.env["PATH"]).toBe("/opt/agent/bin:/home/mira/.local/bin:/usr/bin");
    // The credential travels in the reply alone, never in the agent's environment.
    expect(JSON.stringify(reply?.env)).not.toContain(reply?.credential ?? "-");
    // Another launch gets the shared base.
    const plain = await dispatched();
    const again = await claim(plain.ticket);
    expect(asked).toEqual([login.id, plain.id]);
    expect(again.replies[0]?.env).not.toHaveProperty("FROM_FOLDER");
  });
});

describe("[A5.3.9.shim.session-end] a session runs while its shim follows it, and its end is recorded", () => {
  /** A launch whose agent started and settled: Confirmed, and running. */
  async function running(pid = SHIM_PID): Promise<{ id: string; attachment: Attachment }> {
    live.set(pid, SHIM_START);
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket, { pid })).outcome);
    await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now });
    await host.report(attachment, SHIM_METHODS.settled, {});
    return { id, attachment };
  }

  test("an agent's end, by its code or by a signal, records how long it ran and ends the session", async () => {
    const { id, attachment } = await running();
    expect(host.running(id)).toBe(true);
    await host.report(attachment, SHIM_METHODS.exited, {
      code: null,
      signal: "SIGHUP",
      ran_ms: 125_000,
      settled: true,
    });
    expect(await read(id)).toMatchObject({ state: "confirmed", evidence: { ran_ms: 125_000 } });
    expect(host.running(id)).toBe(false);
    // One that ended within 3 s failed, with how long it ran.
    const early = await dispatched();
    const a = attachmentOf((await claim(early.ticket)).outcome);
    await host.report(a, SHIM_METHODS.exited, {
      code: 1,
      signal: null,
      ran_ms: 400,
      settled: false,
    });
    expect(await read(early.id)).toMatchObject({
      state: "failed",
      evidence: { exit_code: 1, ran_ms: 400 },
    });
  });

  test("a shim gone without a report stops running at once, and the PID check records that it went", async () => {
    const { id } = await running();
    // Killed outright: no report. The page's next look already sees it is not running.
    live.delete(SHIM_PID);
    expect(host.running(id)).toBe(false);
    pass(30_000);
    expect(await host.check()).toBe(1);
    const after = await read(id);
    expect(after).toMatchObject({ state: "confirmed", evidence: { lost_at: now } });
    expect(after?.evidence.ran_ms).toBeUndefined();
    expect(records.get(id)).toBeUndefined();
  });

  test("after a restart only a session whose shim still runs is running; one that ended meanwhile is recorded", async () => {
    const alive = await running(SHIM_PID + 1);
    const gone = await running(SHIM_PID + 2);
    const ended = await running(SHIM_PID + 3);
    // The service stops. One shim dies without a word; another's agent ends and its shim writes
    // exit.json, then waits for Enter.
    live.delete(SHIM_PID + 2);
    (records as MemoryRecords).exits.set(ended.id, {
      format: 1,
      launch: ended.id,
      spawned: true,
      settled: true,
      code: 0,
      signal: null,
      ran_ms: 90_000,
    });
    boot();
    expect(host.running(alive.id)).toBe(true);
    expect(host.running(gone.id)).toBe(false);
    await machine.recover();
    expect(await host.check()).toBe(2);
    expect(await read(gone.id)).toMatchObject({ state: "confirmed", evidence: { lost_at: now } });
    expect(await read(ended.id)).toMatchObject({
      state: "confirmed",
      evidence: { exit_code: 0, ran_ms: 90_000 },
    });
    expect(host.running(ended.id)).toBe(false);
    expect(host.running(alive.id)).toBe(true);
    expect((await read(alive.id))?.evidence).not.toHaveProperty("lost_at");
  });

  test("an agent that ends within 3 s after the bridge confirmed its session records its end", async () => {
    live.set(SHIM_PID, SHIM_START);
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now });
    await machine.report(id, () => ({ kind: "confirmed", evidence: { bound_at: now } }));
    expect(host.running(id)).toBe(true);
    await host.report(attachment, SHIM_METHODS.exited, {
      code: 0,
      signal: null,
      ran_ms: 2_000,
      settled: false,
    });
    expect(await read(id)).toMatchObject({
      state: "confirmed",
      evidence: { bound_at: now, exit_code: 0, ran_ms: 2_000 },
    });
    expect(host.running(id)).toBe(false);
  });

  test("a launch whose agent has not started is not running", async () => {
    const { id, ticket } = await dispatched();
    attachmentOf((await claim(ticket)).outcome);
    expect(host.running(id)).toBe(false);
    expect(host.running("la_00000000000000000000000000")).toBe(false);
  });
});

describe("[A4.5.shim.attach] what the click records of the agent it starts", () => {
  const temps: { remove: () => void }[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) t.remove();
  });

  /** Folder records of a fresh service life, in a temporary folder: the launch root. */
  function folderRecords(): string {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    return root;
  }

  test("the app, the home, the preset and the session the launch is, read back after a restart", async () => {
    const root = folderRecords();
    const { id } = await dispatched();
    const want = { ...GIVEN, session: `se_${id.slice("la_".length)}` };
    expect(host.record(id)).toMatchObject(want);
    expect(new FolderRecords(root).get(id)).toMatchObject(want);
    // A launch that continues a session is that session.
    const continued = "se_0k3m5n7p9q1r3s5t7v9w1x3y5z";
    expect(sessionOf({ id, session: continued })).toBe(continued);
  });

  test("a value the reader would refuse is left out at the click, so the launch is still read back", async () => {
    const root = folderRecords();
    const { id } = await dispatched("terminal", PLAN, {
      app: "Codex App",
      home: "/home/mira/.codex\u0007work",
      preset: "not-a-uuid",
    });
    const back = new FolderRecords(root).get(id);
    expect(back?.plan).toEqual(PLAN);
    expect(back).not.toHaveProperty("app");
    expect(back).not.toHaveProperty("home");
    expect(back).not.toHaveProperty("preset");
    expect(back?.session).toBe(`se_${id.slice("la_".length)}`);
  });

  test("a record of the build before loads, and a field this build does not know is left aside, as the build before leaves this build's", async () => {
    const root = folderRecords();
    const { id, ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now });
    const file = join(root, id, "launch.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // The builds before refuse a ticket without `bridgeUsed`: written for a rollback, read by none.
    const { bridgeUsed, ...ticketRead } = written["ticket"] as Record<string, unknown>;
    expect(bridgeUsed).toBe(false);
    const loaded: Record<string, unknown> = { ...written, ticket: ticketRead };
    const { app, home, session, preset, ...before } = loaded;
    expect([app, home, session, preset].every((v) => typeof v === "string")).toBe(true);
    writeFileSync(file, JSON.stringify({ ...before, ticket: written["ticket"] }));
    expect(new FolderRecords(root).get(id)).toEqual(before);
    // A later build's field: the record loads with every field this build knows, as written.
    writeFileSync(file, JSON.stringify({ ...written, thread: "a later build's field" }));
    expect(new FolderRecords(root).get(id)).toEqual({ ...written, ticket: ticketRead });
  });
});

describe("[A4.5.shim.attach] an ended launch leaves nothing", () => {
  const temps: { remove: () => void }[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) t.remove();
  });

  test("its folder goes with its end and nothing of it stays; a start removes the records earlier builds kept of ended launches", async () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    const { ticket } = await dispatched();
    const attachment = attachmentOf((await claim(ticket)).outcome);
    await host.report(attachment, SHIM_METHODS.started, { pid: 5151, started_at: now });
    await host.report(attachment, SHIM_METHODS.exited, {
      code: 0,
      signal: null,
      ran_ms: 60_000,
      settled: true,
    });
    expect(readdirSync(root)).toEqual([]);
    expect(host.liveByTicket(ticket)).toBeUndefined();

    // What an earlier build left: a record of an ended launch, beside a launch still running.
    const running = await dispatched();
    const ended = join(root, "ended");
    mkdirSync(ended);
    writeFileSync(join(ended, `${randomId("la")}.json`), '{"format":1}');
    records = new FolderRecords(root);
    boot();
    expect(existsSync(ended)).toBe(false);
    expect(records.get(running.id)?.launch).toBe(running.id);
  });

  test("a start removes only the old records it knows from the ended folder: anything else there, and a link in its place, stays", () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    const ended = join(root, "ended");
    mkdirSync(ended, { recursive: true });
    const record = join(ended, `${randomId("la")}.json`);
    const other = join(ended, "space.sqlite");
    writeFileSync(record, '{"format":1}');
    writeFileSync(other, "not a record");
    new FolderRecords(root);
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(ended)).toEqual(["space.sqlite"]);

    // A link in the folder's place is not the product's: neither it nor what it names is touched.
    rmSync(ended, { recursive: true });
    const elsewhere = join(temp.path, "elsewhere");
    mkdirSync(elsewhere);
    const linked = join(elsewhere, `${randomId("la")}.json`);
    writeFileSync(linked, '{"format":1}');
    symlinkSync(elsewhere, ended, "junction");
    new FolderRecords(root);
    expect(existsSync(ended)).toBe(true);
    expect(existsSync(linked)).toBe(true);
  });

  test("a start removes a launch folder with no record once the folder is a day old, unless the shim its file names may still run; a link in its place stays", async () => {
    const temp = tempFolder();
    temps.push(temp);
    const root = join(temp.path, "launch");
    records = new FolderRecords(root);
    boot();
    const kept = await dispatched();
    const old = (Date.now() - FOLDER_MAX_AGE_MS - 60_000) / 1000;
    const folderOf = (file: string | undefined): string => {
      const folder = join(root, randomId("la"));
      mkdirSync(folder);
      if (file !== undefined) writeFileSync(join(folder, "launch.json"), file);
      return folder;
    };
    const damaged = folderOf("{not json");
    const empty = folderOf(undefined);
    const fresh = folderOf("{not json");
    // A file this build cannot read as a record, that still names a shim that runs: this process.
    const live = folderOf(
      JSON.stringify({
        launch: "x",
        attachment: { pid: process.pid, startTime: await ownStartTime() },
      }),
    );
    const gone = folderOf(
      JSON.stringify({ launch: "x", attachment: { pid: 1 << 30, startTime: "x" } }),
    );
    // A link in a launch folder's place leads out of the launch root: neither is touched.
    const elsewhere = join(temp.path, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "launch.json"), "{not json");
    const linked = join(root, randomId("la"));
    symlinkSync(elsewhere, linked, "junction");
    const notLaunch = join(root, "space-folder");
    mkdirSync(notLaunch);
    for (const folder of [damaged, empty, live, gone, elsewhere, notLaunch, join(root, kept.id)]) {
      utimesSync(folder, old, old);
    }
    const removed: string[] = [];
    records = new FolderRecords(root, { removed: (launch) => removed.push(launch) });
    boot();
    expect(existsSync(damaged)).toBe(false);
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(gone)).toBe(false);
    expect(removed.sort()).toEqual(
      [damaged, empty, gone].map((f) => f.slice(root.length + 1)).sort(),
    );
    for (const folder of [fresh, live, linked, notLaunch]) expect(existsSync(folder)).toBe(true);
    expect(existsSync(join(elsewhere, "launch.json"))).toBe(true);
    // A launch's own record keeps its folder whatever its age: the PID check decides on it.
    expect(records.get(kept.id)?.launch).toBe(kept.id);
  });

  // Only Windows holds a file against its removal; elsewhere the folder's mode decides.
  test.skipIf(process.platform !== "win32")(
    "an old record another program holds stays, with its folder, and a later start removes it",
    () => {
      const temp = tempFolder();
      temps.push(temp);
      const root = join(temp.path, "launch");
      const ended = join(root, "ended");
      mkdirSync(ended, { recursive: true });
      const held = join(ended, `${randomId("la")}.json`);
      writeFileSync(held, '{"format":1}');
      const hold = holdFile(held);
      try {
        new FolderRecords(root);
        expect(existsSync(held)).toBe(true);
      } finally {
        hold.release();
      }
      new FolderRecords(root);
      expect(existsSync(ended)).toBe(false);
    },
  );
});
