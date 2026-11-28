// The generated interleavings of the phone's outbox: random sequences of what the person does on
// the phone (check off, Undo, capture), of faults at the link's socket (an answer lost with the
// link or on an open one, the link dropped, the feed or the answers held back), of a restart of the
// app (a new session on the same kept files), and of the computer changing the same tasks (finished,
// reopened, to the Trash) and closing and opening the space. Against the real service.
//
// When all is quiet and the link is up: the phone holds the same open tasks as the computer, and its
// Today is the one the same grouping gives for the computer's rows; a task the computer did not
// touch is as the person's last tap left it (checked off, or open again by Undo), with no refusal;
// each capture is on both, once; and nothing waits.
//
// A failure prints its seed; FC_SEED replays it, and FC_RUNS sets how many sequences run. Fixture
// text only.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, onTestFailed, test } from "vitest";
import { spaceSession, type Keep, type Saved, type SpaceView } from "@ttasks/client/link";
import type { TaskRow } from "@ttasks/client/store";
import { todayOf, type Clock } from "@ttasks/client/today";
import { localDate } from "@ttasks/contracts/day";
import type { PhoneKey } from "./phone-client.ts";
import { faulty, memory, pairedPhone, phone, phoneWorld, until } from "./phone-link.ts";

const RUNS = Number(process.env["FC_RUNS"] ?? 4);
const LONG = Math.max(600_000, RUNS * 90_000);

let w: Awaited<ReturnType<typeof phoneWorld>>;

beforeAll(async () => {
  w = await phoneWorld("phone-interleavings");
}, LONG);

afterAll(async () => {
  await w.end();
}, LONG);

type Step =
  | { readonly t: "finish"; readonly i: number }
  | { readonly t: "undo" }
  | { readonly t: "capture" }
  | { readonly t: "dropAnswer" }
  | { readonly t: "withholdAnswer" }
  | { readonly t: "dropLink" }
  | { readonly t: "holdFeed" }
  | { readonly t: "holdAnswers" }
  | { readonly t: "release" }
  | { readonly t: "restart" }
  | { readonly t: "computer"; readonly what: "finish" | "reopen" | "trash"; readonly i: number }
  | { readonly t: "close" }
  | { readonly t: "open" }
  | { readonly t: "wait"; readonly ms: number };

const TASKS = 3;
const task = fc.integer({ min: 0, max: TASKS - 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: task.map((i) => ({ t: "finish" as const, i })) },
  { weight: 3, arbitrary: fc.constant({ t: "undo" as const }) },
  { weight: 3, arbitrary: fc.constant({ t: "capture" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "dropAnswer" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "withholdAnswer" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "dropLink" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "holdFeed" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "holdAnswers" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "release" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "restart" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("computer" as const),
      what: fc.constantFrom("finish" as const, "reopen" as const, "trash" as const),
      i: task,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "close" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "open" as const }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 300 }).map((ms) => ({ t: "wait" as const, ms })),
  },
);

/** A session of the phone, its faults and its last view. */
function session(key: PhoneKey, saved: Saved, keep: Keep) {
  const { connect, faults } = faulty(phone(key).connect);
  const seen: { view?: SpaceView } = {};
  const live = spaceSession({
    connect,
    saved,
    keep,
    newId: randomUUID,
    report: (view) => {
      seen.view = view;
    },
    retryMs: 50,
    resendMs: 50,
    callMs: 400,
  });
  live.start();
  return { live, faults, seen };
}

/** The task as the computer holds it: open, or not (finished, in the Trash). */
async function open(ref: string): Promise<boolean> {
  const got = await w.op("task.get", { task: ref });
  const row = got.result?.["task"] as
    { lifecycle?: string; deleted?: unknown; deleted_at?: unknown } | undefined;
  return (
    got.status === 200 &&
    row?.lifecycle === "active" &&
    row.deleted === undefined &&
    row.deleted_at === undefined
  );
}

/** A change on the computer, as the page makes it; one it cannot make now is left. */
async function onComputer(what: "finish" | "reopen" | "trash", ref: string): Promise<void> {
  const got = await w.op("task.get", { task: ref });
  const base = got.result?.["as_of"];
  if (typeof base !== "string") return;
  const request_id = randomUUID();
  if (what === "trash") await w.op("task.delete", { tasks: [ref], base, request_id });
  else await w.op(`task.${what}`, { task: ref, base, request_id });
}

/** Waits for `holds` at most `ms`, then fails with what the phone shows. */
async function within(
  ms: number,
  what: string,
  view: () => SpaceView | undefined,
  holds: () => boolean,
) {
  const deadline = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > deadline) {
      const v = view();
      throw new Error(
        `${what}: ${JSON.stringify({
          link: v?.link.kind,
          live: v?.live,
          settling: v?.settling,
          waiting: v?.waiting.map((e) => [e.kind, e.tried]),
          refused: v?.refused.map((r) => [r.kind, r.why]),
          tasks: [...(v?.tasks.values() ?? [])].map((t) => [t.title, t.lifecycle]),
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const openIds = (rows: ReadonlyMap<string, TaskRow>): string[] =>
  [...rows.values()]
    .filter((t) => t.lifecycle === "active")
    .map((t) => t.id)
    .sort();
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
/** Today's sections and their tasks, in order: what the phone shows. */
const sectionsOf = (rows: ReadonlyMap<string, TaskRow>, clock: Clock) =>
  todayOf(rows.values(), clock).sections.map((s) => [s.key, s.tasks.map((t) => t.id)]);

let run = 0;

describe("[S5.phone.interleavings] the phone's outbox through generated sequences", () => {
  test(
    "when all is quiet the phone shows what the computer holds, each capture once, nothing waiting",
    async () => {
      const seed = Number(process.env["FC_SEED"] ?? Math.floor(Math.random() * 2 ** 31));
      onTestFailed(() => {
        console.error(`Replay with FC_SEED=${String(seed)}`);
      });
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
          run += 1;
          const label = `G${String(run)}`;
          const { key, saved } = await pairedPhone(w, label);
          const refs: { ref: string; id: string; title: string }[] = [];
          for (let i = 0; i < TASKS; i += 1) {
            const title = `${label} task ${String(i)}`;
            refs.push({ ...(await w.added(title)), title });
          }
          const keep = memory();
          let s = session(key, saved, keep);
          await until(
            () =>
              s.seen.view?.live === true &&
              refs.every((r) => s.seen.view?.tasks.has(r.id) === true),
          );
          const finishes: { request: string; i: number }[] = [];
          /** What the person's taps leave each task: open, or checked off. */
          const meant = refs.map(() => true);
          /** The tasks the computer changed itself: their end is the computer's to say. */
          const touched = new Set<number>();
          const captures: string[] = [];
          let closed = false;

          for (const st of steps) {
            switch (st.t) {
              case "finish": {
                const row = s.seen.view?.tasks.get(refs[st.i]?.id ?? "");
                if (row?.lifecycle === "active") {
                  finishes.push({ request: s.live.finish(row), i: st.i });
                  meant[st.i] = false;
                }
                break;
              }
              case "undo": {
                const last = finishes.pop();
                if (last !== undefined) {
                  s.live.undo(last.request);
                  meant[last.i] = true;
                }
                break;
              }
              case "capture": {
                const title = `${label} capture ${String(captures.length)}`;
                captures.push(title);
                s.live.add({ title, inbox: true }, title);
                break;
              }
              case "dropAnswer":
                s.faults.dropAnswer += 1;
                break;
              case "withholdAnswer":
                s.faults.withholdAnswer += 1;
                break;
              case "dropLink":
                s.faults.drop();
                break;
              case "holdFeed":
                s.faults.holdFeed = true;
                break;
              case "holdAnswers":
                s.faults.holdAnswers = true;
                break;
              case "release":
                s.faults.release();
                break;
              case "restart":
                s.live.stop();
                // A new run of the app: what it knew of this run's taps (their Undo) is gone.
                finishes.length = 0;
                s = session(key, saved, keep);
                break;
              case "computer":
                if (!closed) {
                  touched.add(st.i);
                  await onComputer(st.what, refs[st.i]?.ref ?? "");
                }
                break;
              case "close":
                if (!closed) {
                  await w.close();
                  closed = true;
                }
                break;
              case "open":
                if (closed) {
                  await w.open();
                  closed = false;
                }
                break;
              case "wait":
                await new Promise((resolve) => setTimeout(resolve, st.ms));
                break;
            }
          }

          // All quiet: no fault left, the space open, the link up.
          s.faults.dropAnswer = 0;
          s.faults.withholdAnswer = 0;
          s.faults.answer = undefined;
          s.faults.release();
          if (closed) await w.open();
          const quiet = () =>
            s.seen.view?.live === true && s.seen.view.waiting.length === 0 && !s.seen.view.settling;
          await within(60_000, "quiet", () => s.seen.view, quiet);

          // The feed comes after the answers: the phone shows what the computer holds once it has.
          const holds = await Promise.all(refs.map((r) => open(r.ref)));
          await within(
            20_000,
            `the computer holds ${JSON.stringify(holds)}`,
            () => s.seen.view,
            () =>
              refs.every(
                (r, i) => (s.seen.view?.tasks.get(r.id)?.lifecycle === "active") === holds[i],
              ),
          );
          refs.forEach((r, i) => {
            if (!touched.has(i))
              expect(holds[i], `${r.title} as the person left it`).toBe(meant[i]);
          });
          const untouched = new Set(refs.filter((_, i) => !touched.has(i)).map((r) => r.title));
          expect(s.seen.view?.refused.filter((r) => untouched.has(r.words))).toEqual([]);
          // The phone's whole list and its Today, against the computer's rows.
          const computer = await w.rows();
          const phoneRows = () => s.seen.view?.tasks ?? new Map<string, TaskRow>();
          await within(
            20_000,
            "the computer's open tasks",
            () => s.seen.view,
            () => same(openIds(phoneRows()), openIds(computer)),
          );
          const clock: Clock = {
            now: Date.now(),
            today: localDate(Date.now(), "UTC"),
            timeZone: "UTC",
            locale: "en",
          };
          expect(sectionsOf(phoneRows(), clock)).toEqual(sectionsOf(computer, clock));
          for (const title of captures) {
            expect(await w.found(`"${title}"`), title).toBe(1);
            expect(
              [...phoneRows().values()].filter(
                (t) => t.title === title && t.lifecycle === "active",
              ),
              `${title} on the phone`,
            ).toHaveLength(1);
          }
          expect(s.seen.view?.refused.filter((r) => r.kind === "add")).toEqual([]);
          s.live.stop();
        }),
        { seed, numRuns: RUNS, endOnFailure: true },
      );
    },
    LONG,
  );
});
