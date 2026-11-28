// The replay (piece iii): today's service requests sent through both backends, one service serving
// a space on today's writer and a tree space, and compared step by step: the answer each call got
// and what a reader then sees of every task the steps named (`task.get`). Each space numbers and
// names its own IDs, references and times, so both answers are compared with those in order of
// first appearance. The calls are those `answers.test.ts` and its kin send, one family at a time.
// A step where the backends may differ says why in one line. Fixture text only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { CheckedDriver, createSpace, loadDriver, DEFAULT_DRIVER } from "@ttasks/storage";
import { both, type Sequence, type Side } from "../../storage/test/both-helpers.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { classSession } from "./ops-helpers.ts";

const LONG = 180_000;
let w: ContractWorld & { root: string };
let tree: string;

beforeAll(async () => {
  w = await contractWorld("replay");
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const folder = join(w.root, "s", "tree");
  createSpace(checked, folder, {
    name: "Mira",
    refPrefix: "T",
    machineId: w.service.ops.machine.id as `m_${string}`,
    ownerLabel: "user",
    tree: true,
  });
  const person = await classSession(w.home, w.path, "cli-interactive");
  try {
    const opened = (await person.call("space/open", { path: folder })) as { space: { id: string } };
    tree = opened.space.id;
  } finally {
    person.close();
  }
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const AGENT: Caller = { class: "cli-script", env: {} };
const USER: Caller = { class: "cli-interactive", env: {} };

/** One call: `{name}` in its input is a task an earlier step named; `base` the latest as_of. */
interface Step {
  op: string;
  input: Record<string, unknown>;
  /** The task this call's answer names, by a name later steps use. */
  as?: string;
  user?: true;
  base?: true;
  /** A stale base: the as_of after that earlier step (1 is the first). */
  baseFrom?: number;
  /** The request ID of an earlier step, sent again as a client whose reply was lost does. */
  again?: number;
}

interface Session {
  space: string;
  names: Map<string, string>;
  asOf: string | undefined;
  ids: Map<string, string>;
  sent: string[];
  /** The as_of after each step. */
  after: (string | undefined)[];
  /** This sequence's run in its space: request IDs are a space's, across sequences. */
  run: number;
}

/** How many sequences each space has run. */
const runs = new Map<string, number>();

/** Each space's own IDs, references and times, as tokens in order of first appearance. */
function normal(value: unknown, s: Session): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b\d+\.\d+\.[0-9a-z]{8,}\b/gu, "<as_of>")
      .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/gu, "<at>")
      .replace(/\b(?:[a-z]{1,3}_[0-9a-z]{26}|[A-Z]{1,6}-\d+)\b/gu, (id) => {
        let token = s.ids.get(id);
        if (token === undefined) {
          token = `<${String(s.ids.size + 1)}>`;
          s.ids.set(id, token);
        }
        return token;
      });
  }
  if (Array.isArray(value)) return value.map((v) => normal(v, s));
  if (typeof value === "object" && value !== null) {
    // A version is a seq of its space's own commits.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "version" ? "<version>" : normal(v, s)]),
    );
  }
  return value;
}

const filled = (value: unknown, s: Session): unknown => {
  if (typeof value === "string") {
    return value.replace(/\{(\w+)\}/gu, (_, name: string) => s.names.get(name) ?? `{${name}}`);
  }
  if (Array.isArray(value)) return value.map((v) => filled(v, s));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filled(v, s)]));
  }
  return value;
};

type Sent =
  { ok: Record<string, unknown>; error?: undefined } | { ok?: undefined; error: ErrorBody };

async function send(
  s: Session,
  op: string,
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Sent> {
  try {
    const ok = (await opCall(w.service.ops, caller, { op, input, space: s.space })) as Record<
      string,
      unknown
    >;
    return { ok };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { error: error.toBody() };
  }
}

/** The first task reference an answer names. */
const refIn = (answer: unknown): string | undefined =>
  /\b[A-Z]{1,6}-\d+\b/u.exec(JSON.stringify(answer ?? {}))?.[0];

/** One backend: the steps sent to its space, and the tasks they named read after each. */
const backend = (space: () => string): Side<Step, Session> => ({
  open: () =>
    Promise.resolve({
      space: space(),
      names: new Map(),
      asOf: undefined,
      ids: new Map(),
      sent: [],
      after: [],
      run: (() => {
        const n = (runs.get(space()) ?? 0) + 1;
        runs.set(space(), n);
        return n;
      })(),
    }),
  step: async (s, step) => {
    const id =
      step.again === undefined
        ? `replay-${String(s.run)}-request-${String(s.sent.length + 1).padStart(6, "0")}`
        : (s.sent[step.again - 1] ?? "");
    s.sent.push(id);
    const input = {
      ...(filled(step.input, s) as Record<string, unknown>),
      ...(step.op === "task.get" ? {} : { request_id: id }),
      ...(step.base === true && s.asOf !== undefined ? { base: s.asOf } : {}),
      ...(step.baseFrom === undefined ? {} : { base: s.after[step.baseFrom - 1] }),
    };
    const got = await send(s, step.op, input, step.user === true ? USER : AGENT);
    s.after.push(undefined);
    if (got.ok !== undefined) {
      const asOf = (got.ok as { as_of?: unknown }).as_of;
      if (typeof asOf === "string") s.asOf = asOf;
      s.after[s.after.length - 1] = s.asOf;
      const ref = refIn(got.ok);
      if (step.as !== undefined && ref !== undefined) s.names.set(step.as, ref);
      return { status: "ok", said: normal(got.ok, s) };
    }
    return { status: "error", code: got.error.code, said: normal(got.error, s) };
  },
  seen: async (s) => {
    const seen: Record<string, unknown> = {};
    for (const [name, ref] of s.names) {
      const read = await send(s, "task.get", { task: ref }, USER);
      seen[name] = normal(read.ok ?? { error: read.error.code }, s);
    }
    return seen;
  },
  close: () => undefined,
});

const replay = (steps: Sequence<Step>) =>
  both({ today: backend(() => w.space), tree: backend(() => tree) }, steps);

/** The tasks family, as `answers.test.ts` sends it. */
const TASKS: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Renew the passport" }] }, as: "passport" },
  { op: "task.add", input: { tasks: [{ title: "Renew the passport" }] }, again: 1 },
  {
    op: "task.update",
    input: { task: "{passport}", set: { title: "Renew both passports", priority: 2 } },
    base: true,
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "Book the van", summary: "Before the move" }] },
    as: "van",
  },
  { op: "task.finish", input: { task: "{van}", outcome: "Booked for Monday" }, base: true },
  { op: "task.reopen", input: { task: "{van}" }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{passport}"] }, base: true, user: true },
];

const ticket = (key: string) => ({ key, kind: "ticket", title: "Fixture ticket" });

/** Captures, a lost reply after a rename, a request ID reused, a stale base and repeats. */
const AGAIN: Sequence<Step> = [
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed before", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
    as: "keyed",
  },
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
  },
  {
    op: "task.update",
    input: { task: "{keyed}", set: { title: "Keyed and renamed" } },
    base: true,
  },
  {
    step: {
      op: "task.add",
      input: {
        tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
      },
      again: 2,
    },
    differs: "a retry: today answers with the title now, the tree with what the write did (C-3)",
  },
  { op: "task.add", input: { tasks: [{ title: "Second under its ID" }] }, again: 1 },
  {
    op: "task.update",
    input: { task: "{keyed}", set: { title: "From a stale read" } },
    baseFrom: 1,
  },
  { op: "task.update", input: { task: "{keyed}", set: { priority: 1 } }, base: true },
  { op: "task.update", input: { task: "{keyed}", set: { priority: 1 } }, base: true },
  { op: "task.finish", input: { task: "{keyed}", outcome: "Answered" }, base: true, user: true },
  { op: "task.finish", input: { task: "{keyed}", outcome: "Answered" }, base: true, user: true },
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "Keyed later", sources: [ticket("fixture:meanwhile-1")], log: "Asked again" },
      ],
    },
  },
  { op: "task.delete", input: { tasks: ["{keyed}"] }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{keyed}"] }, base: true, user: true },
  { op: "task.get", input: { task: "X-999" } },
];

describe("[S2.replay.tasks] today's service requests through both backends: the tasks family", () => {
  test(
    "add, a lost reply sent again, update, finish, reopen and the Trash, with what a reader then sees",
    async () => {
      await replay(TASKS);
    },
    LONG,
  );

  test(
    "captures by source with their log, a lost reply after a rename, a request ID reused, a stale base and repeats",
    async () => {
      await replay(AGAIN);
    },
    LONG,
  );
});
