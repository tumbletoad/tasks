// The replay's machinery (piece iii): one call as a step, said to a service that serves a space on
// today's writer and a tree space, and what a reader then sees, compared by the strict helper
// (storage's both-helpers.ts). Each space numbers its own IDs, references, as_of and versions, so
// both are compared by their relations: each value becomes a token in order of first appearance,
// and a value that comes back gets its token again. Times are left out of that, as two commits in
// one millisecond are chance; a retry is held to the as_of its first answer gave, in each space.
// Fixture text only.
import { join } from "node:path";
import { expect } from "vitest";
import { AppError, findEntry, type ErrorBody } from "@ttasks/contracts";
import { CheckedDriver, createSpace, loadDriver, DEFAULT_DRIVER } from "@ttasks/storage";
import type { Side } from "../../storage/test/both-helpers.ts";

export type { Side };
import { opCall, type Caller, type OpsHost } from "../src/ops/index.ts";
import type { ContractWorld } from "./contract/suite.ts";
import { classSession } from "./ops-helpers.ts";

/**
 * A new space of each backend in the world's service, named and prefixed alike, so what one
 * shows of itself (its name, its prefix) is the other's too. `close` closes both, with their
 * workers: a run of many sequences holds only the spaces of the one it runs.
 */
export async function newSpaces(
  w: ContractWorld & { root: string },
  name: string,
): Promise<{ today: string; tree: string; close(): Promise<void> }> {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const person = await classSession(w.home, w.path, "cli-interactive");
  try {
    const folders: string[] = [];
    const open = async (tree: boolean) => {
      const folder = join(w.root, "s", `${name}-${tree ? "tree" : "today"}`);
      folders.push(folder);
      createSpace(checked, folder, {
        name: "Mira",
        refPrefix: "M",
        machineId: w.service.ops.machine.id as `m_${string}`,
        ownerLabel: "user",
        ...(tree ? { tree: true } : {}),
      });
      const opened = (await person.call("space/open", { path: folder })) as {
        space: { id: string };
      };
      return opened.space.id;
    };
    const today = await open(false);
    const tree = await open(true);
    return {
      today,
      tree,
      close: async () => {
        const closer = await classSession(w.home, w.path, "cli-interactive");
        try {
          for (const folder of folders) await closer.call("space/close", { space: folder });
        } finally {
          closer.close();
        }
      },
    };
  } finally {
    person.close();
  }
}

export const AGENT: Caller = { class: "cli-script", env: {} };
export const USER: Caller = { class: "cli-interactive", env: {} };

/** One call: `{name}` in its input is a task an earlier step named; `base` the latest as_of. */
export interface Step {
  op: string;
  input: Record<string, unknown>;
  /** The task this call's answer names, by a name later steps use. */
  as?: string;
  /** The entry this call's answer names (`n2`, `l3`), by a name later steps use. */
  entry?: string;
  /** The page this call's answer names (its `target`), by a name later steps use. */
  page?: string;
  user?: true;
  base?: true;
  /** A stale base: the as_of after that earlier step (1 is the first). */
  baseFrom?: number;
  /** The request ID of an earlier step, sent again as a client whose reply was lost does. */
  again?: number;
  /** The base of two steps back: a read from before the last change. */
  stale?: true;
  /** Sent twice under one request ID: the second answer is held to the first, in each space. */
  retry?: true;
}

export interface Session {
  space: string;
  names: Map<string, string>;
  /** The entries and pages steps named. */
  entries: Map<string, string>;
  asOf: string | undefined;
  ids: Map<string, string>;
  sent: string[];
  /** The as_of after each step. */
  after: (string | undefined)[];
  /** The as_of each step's own answer gave. */
  answered: (string | undefined)[];
  /** Every task reference an answer named, read after each step. */
  refs: Set<string>;
  /** How many tokens of each kind the space has given. */
  counts: Map<string, number>;
  /** This sequence's run in its space: request IDs are a space's, across sequences. */
  run: number;
}

/** How many sequences each space has run. */
const runs = new Map<string, number>();

/** `value`'s token in this space: the same value, the same token. */
export function token(s: Session, kind: string, value: string): string {
  const key = `${kind}:${value}`;
  let found = s.ids.get(key);
  if (found === undefined) {
    // Each kind counts its own, so one kind's coincidence never shifts another's numbers.
    const n = (s.counts.get(kind) ?? 0) + 1;
    s.counts.set(kind, n);
    found = `<${kind}${String(n)}>`;
    s.ids.set(key, found);
  }
  return found;
}

/** An entry's reference is its task's own: `n2` of one task is not `n2` of another. */
const ENTRY = /^[nl][1-9]\d{0,5}$/u;

/** Each space's own IDs, references, as_of and versions as tokens; its times left out. */
export function normal(value: unknown, s: Session, task = ""): unknown {
  if (typeof value === "string") {
    // An entry's number is its space's own: the tree numbers a task's notes and log in one thread.
    if (ENTRY.test(value)) return token(s, "e", `${task}|${value}`);
    return (
      value
        .replace(/\b\d+\.\d+\.[0-9a-z]{8,}\b/gu, (asOf) => token(s, "as_of", asOf))
        .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/gu, "<at>")
        .replace(/\b(?:[a-z]{1,3}_[0-9a-z]{26}|[A-Z]{1,6}-\d+)\b/gu, (id) => token(s, "", id))
        // A system commit's request ID ends in a random part of its own.
        .replace(/\b(register-[a-z]+)-[0-9a-z]{26}\b/gu, (_, name: string) => `${name}-<random>`)
    );
  }
  if (Array.isArray(value)) return value.map((v) => normal(v, s, task));
  if (typeof value === "object" && value !== null) {
    const own = (value as Record<string, unknown>)["task"];
    const scope = typeof own === "string" ? own : task;
    // A batch's coverage is in commit seqs.
    const batch = (value as Record<string, unknown>)["type"] === "batch";
    // A version and a seq count the space's own commits; a time in milliseconds is a time.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        (k === "version" ||
          k === "seq" ||
          k === "touched" ||
          (batch && (k === "from" || k === "through"))) &&
        typeof v === "number"
          ? token(s, "v", String(v))
          : /(?:^|_)(?:at|since)$/u.test(k) && typeof v === "number"
            ? "<at>"
            : normal(v, s, scope),
      ]),
    );
  }
  return value;
}

const filled = (value: unknown, s: Session): unknown => {
  if (typeof value === "string") {
    return value.replace(
      /\{(\w+)\}/gu,
      (_, name: string) => s.names.get(name) ?? s.entries.get(name) ?? `{${name}}`,
    );
  }
  if (Array.isArray(value)) return value.map((v) => filled(v, s));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filled(v, s)]));
  }
  return value;
};

export type Sent =
  { ok: Record<string, unknown>; error?: undefined } | { ok?: undefined; error: ErrorBody };

export async function send(
  ops: OpsHost,
  s: Session,
  op: string,
  input: Record<string, unknown>,
  caller: Caller,
): Promise<Sent> {
  try {
    const ok = (await opCall(ops, caller, { op, input, space: s.space })) as Record<
      string,
      unknown
    >;
    return { ok };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { error: error.toBody() };
  }
}

/** The targets an answer hands out to read next, at any depth (`read`). */
export function readsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(readsIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    k === "read" && typeof v === "string" ? [v] : readsIn(v),
  );
}

/** The task references an answer names, the first first. */
export const refsIn = (answer: unknown): string[] =>
  JSON.stringify(answer ?? {}).match(/\b[A-Z]{1,6}-\d+\b/gu) ?? [];

/** One backend: the steps sent to its space, and the tasks they named read after each. */
export const backend = (ops: OpsHost, space: () => string): Side<Step, Session> => ({
  open: () =>
    Promise.resolve({
      space: space(),
      names: new Map(),
      entries: new Map(),
      asOf: undefined,
      ids: new Map(),
      counts: new Map(),
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
      // A read takes no request ID.
      ...(findEntry(step.op)?.kind === "read" ? {} : { request_id: id }),
      ...(step.base === true && s.asOf !== undefined ? { base: s.asOf } : {}),
      ...(step.baseFrom === undefined ? {} : { base: s.after[step.baseFrom - 1] }),
      ...(step.stale === true && s.after.length > 1 ? { base: s.after[s.after.length - 2] } : {}),
    };
    const caller = step.user === true ? USER : AGENT;
    const got = await send(ops, s, step.op, input, caller);
    if (step.retry === true) {
      // A lost reply: the same request again is answered as it was decided, at that commit.
      const again = await send(ops, s, step.op, input, caller);
      const plain = (sent: Sent) => {
        if (sent.ok === undefined) return { error: sent.error.code };
        const rest = { ...sent.ok };
        delete rest["replayed"];
        return rest;
      };
      expect(plain(again), `a retry of ${step.op}`).toEqual(plain(got));
    }
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
      const entry = got.ok["entry"] ?? got.ok["note"];
      if (step.entry !== undefined && typeof entry === "string") s.entries.set(step.entry, entry);
      const target = got.ok["target"];
      if (step.page !== undefined && typeof target === "string") s.entries.set(step.page, target);
      return { status: "ok", said: normal(got.ok, s) };
    }
    return { status: "error", code: got.error.code, said: normal(got.error, s) };
  },
  seen: async (s) => {
    const seen: Record<string, unknown> = {};
    const targets = new Set<string>();
    // A task a step named is keyed by that name, so a mark can name it; the rest by token.
    const names = new Map([...s.names].map(([name, ref]) => [ref, name]));
    for (const ref of s.refs) {
      const read = await send(ops, s, "task.get", { task: ref }, USER);
      for (const target of readsIn(read.ok)) targets.add(target);
      seen[names.get(ref) ?? token(s, "", ref)] = normal(
        read.ok ?? { error: read.error.code },
        s,
        ref,
      );
    }
    // Every node a read hands out to read next (a trail's `read`) is followed as it was given,
    // keyed by its title.
    for (const target of targets) {
      const read = await send(ops, s, "page.read", { target }, USER);
      const title = read.ok?.["title"];
      const key = typeof title === "string" ? title : String(normal(target, s));
      seen[`read ${key}`] = normal(read.ok ?? { error: read.error.code }, s);
    }
    return seen;
  },
  close: () => undefined,
});
