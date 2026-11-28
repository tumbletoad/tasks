// The replay (piece iii): today's service requests sent through both backends, one service serving
// a space on today's writer and a tree space, and compared step by step: the whole answer each call
// got and what a reader then sees of every task any answer named (`task.get`). Each space numbers
// its own IDs, references, as_of and versions, so both are compared by their relations: each value
// becomes a token in order of first appearance, and a value that comes back gets its token again.
// Times are left out of that, as two commits in one millisecond are chance; a retry is held to the
// as_of its first answer gave, in each space. The calls are those `answers.test.ts` and its kin
// send, one family at a time. A step where the backends may differ names that one field and says
// why. Fixture text only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  /** The as_of each step's own answer gave. */
  answered: (string | undefined)[];
  /** Every task reference an answer named, read after each step. */
  refs: Set<string>;
  /** This sequence's run in its space: request IDs are a space's, across sequences. */
  run: number;
}

/** How many sequences each space has run. */
const runs = new Map<string, number>();

/** `value`'s token in this space: the same value, the same token. */
function token(s: Session, kind: string, value: string): string {
  const key = `${kind}:${value}`;
  let found = s.ids.get(key);
  if (found === undefined) {
    found = `<${kind}${String(s.ids.size + 1)}>`;
    s.ids.set(key, found);
  }
  return found;
}

/** Each space's own IDs, references, as_of and versions as tokens; its times left out. */
function normal(value: unknown, s: Session): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b\d+\.\d+\.[0-9a-z]{8,}\b/gu, (asOf) => token(s, "as_of", asOf))
      .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/gu, "<at>")
      .replace(/\b(?:[a-z]{1,3}_[0-9a-z]{26}|[A-Z]{1,6}-\d+)\b/gu, (id) => token(s, "", id));
  }
  if (Array.isArray(value)) return value.map((v) => normal(v, s));
  if (typeof value === "object" && value !== null) {
    // A version and a seq count the space's own commits; a time in milliseconds is a time.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        (k === "version" || k === "seq") && typeof v === "number"
          ? token(s, "v", String(v))
          : /(?:^|_)at$/u.test(k) && typeof v === "number"
            ? "<at>"
            : normal(v, s),
      ]),
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

/** The task references an answer names, the first first. */
const refsIn = (answer: unknown): string[] =>
  JSON.stringify(answer ?? {}).match(/\b[A-Z]{1,6}-\d+\b/gu) ?? [];

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
      answered: [],
      refs: new Set(),
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
    s.answered.push(undefined);
    if (got.ok !== undefined) {
      const asOf = (got.ok as { as_of?: unknown }).as_of;
      if (typeof asOf === "string") s.asOf = asOf;
      s.after[s.after.length - 1] = s.asOf;
      s.answered[s.answered.length - 1] = typeof asOf === "string" ? asOf : undefined;
      // A retry is answered as its request was decided: at that commit, in this space too.
      const first = step.again === undefined ? undefined : s.answered[step.again - 1];
      if (first !== undefined && got.ok["replayed"] === true) {
        expect(asOf, `a retry of step ${String(step.again)}`).toBe(first);
      }
      const refs = refsIn(got.ok);
      for (const ref of refs) s.refs.add(ref);
      if (step.as !== undefined && refs[0] !== undefined) s.names.set(step.as, refs[0]);
      return { status: "ok", said: normal(got.ok, s) };
    }
    return { status: "error", code: got.error.code, said: normal(got.error, s) };
  },
  seen: async (s) => {
    const seen: Record<string, unknown> = {};
    for (const ref of s.refs) {
      const read = await send(s, "task.get", { task: ref }, USER);
      seen[token(s, "", ref)] = normal(read.ok ?? { error: read.error.code }, s);
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
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
    again: 2,
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

/** What review found the tree answered otherwise, and what `answers.test.ts` holds a write to. */
const HELD: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Plan the trip" }] }, as: "trip" },
  // A finish as dropped archives the task; its request ID reused as done is another request.
  { op: "task.finish", input: { task: "{trip}", status: "dropped" }, base: true, user: true },
  {
    op: "task.finish",
    input: { task: "{trip}", status: "done" },
    base: true,
    user: true,
    again: 2,
  },
  // A finished task is not edited by an update.
  { op: "task.update", input: { task: "{trip}", set: { title: "Edited after" } }, base: true },
  { op: "task.add", input: { tasks: [{ title: "Pay the fee" }] }, as: "fee" },
  {
    op: "task.finish",
    input: { task: "{fee}", finished: "2999-01-01T00:00:00Z" },
    base: true,
    user: true,
  },
  {
    op: "task.finish",
    input: { task: "{fee}", finished: "2020-01-01T00:00:00Z", outcome: "Paid" },
    base: true,
    user: true,
  },
  // The Trash with arguments that do not go together.
  {
    op: "task.delete",
    input: { tasks: ["{fee}"], change: "op_0000000000000000000000000a" },
    base: true,
    user: true,
  },
  // A refused batch writes nothing, and the same ID then carries the corrected batch.
  {
    op: "task.add",
    input: { tasks: [{ title: "First of two" }, { title: "Second", status: "x" }] },
  },
  { op: "task.add", input: { tasks: [{ title: "First of two" }, { title: "Second" }] }, again: 9 },
  { op: "task.add", input: { tasks: [{ title: "Same title" }, { title: "Same title" }] } },
  {
    op: "task.add",
    input: {
      tasks: [
        {
          title: "Dated",
          sources: [{ kind: "email", title: "Fixture mail", at: "2026-01-02T03:04:05Z" }],
        },
      ],
    },
    as: "dated",
  },
  // An update without its base, and an accepted ID reused on other tools, well-formed or not.
  { op: "task.update", input: { task: "{dated}", set: { title: "No base" } } },
  { op: "task.update", input: { task: "{dated}", set: { priority: 9 } }, again: 1 },
  { op: "task.reopen", input: { task: "{trip}" }, base: true, again: 1 },
  // A person's edit between a write and its retry: the retry is answered as the write was decided.
  {
    op: "task.add",
    input: { tasks: [{ title: "Call the bank", summary: "About the card" }] },
    as: "bank",
  },
  {
    op: "task.update",
    input: { task: "{bank}", set: { summary: "About the new card" } },
    base: true,
    user: true,
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "Call the bank", summary: "About the card" }] },
    again: 16,
  },
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

  test(
    "a finish dropped and done, a finished task's edit, a future finish, the Trash's arguments, a refused batch, a reused ID, an edit before a retry",
    async () => {
      await replay(HELD);
    },
    LONG,
  );
});
