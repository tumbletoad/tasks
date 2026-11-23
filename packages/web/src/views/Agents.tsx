// Agents as far as the page's data allows: first "Needs you", the open tasks whose newest
// background run stopped to ask the person or whose agent in a terminal waits for them, and every
// task, finished or not, on which agents asked questions that wait for them (shown beneath the
// row, newest first, with one Dismiss), and
// "Working", those whose run or agent works now; then "With an agent", the tasks whose agents are
// in any other state; then "Recent", the tasks an agent or a routine changed in the last seven
// days, the ones it finished included, newest first, one small heading per day. The
// runs' states come from the live rows, the terminal agents' from the Agent Monitor
// (agents-merge.ts). A task is in one group, by the agent that asks most of the person, and every
// one of its agents is listed beneath its row in its own state: the lines say what is true now,
// and no heading can hold a state that is gone. The rows are ordinary rows, so a task expands to
// its thread, where its runs, Stop and the changes are; it stays where it was until it collapses.
// A task in the Trash is placed by the same rule, from its own row read from the Trash: the run it
// shows, or the agents the monitor links to it. So a cold page shows it too, as long as a live task
// would be shown, marked with Restore; a run's card holds its Stop and answer, and an agent in a
// terminal is said to go on until it is stopped there. A row the monitor put in its group is muted
// while the monitor's picture is not current. Below them, every other agent on this computer and
// the plan usage of each account (Computer.tsx).
// "Routines" and the full history with Revert wait for the service's read of sessions and routines.
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { changeLogOf } from "../app/changes.ts";
import { classes } from "../app/css.ts";
import { recentOf } from "../app/views.ts";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Group } from "../groups.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatDay, type Clock } from "../row/dates.ts";
import { focusAfter } from "../row/Row.tsx";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { questionsWaiting, taskRow, type TaskRow } from "../store/rows.ts";
import { Latest } from "../latest.ts";
import { linkedOutside, mergeAgents, type AgentState } from "./agents-merge.ts";
import css from "./Computer.module.css";
import trashCss from "./Trash.module.css";
import { Computer, TaskAgents } from "./Computer.tsx";
import { TaskList, type GroupsOf, type HeldRow } from "./TaskList.tsx";

const styles = classes(css, ["question", "asked", "count", "asks", "words", "more", "dismiss"]);
const trash = classes(trashCss, ["where", "restore"]);

/** Agents' changes may touch any task: its rows fade in and are announced like Today's. */
const ANY = (): boolean => true;

/** The groups of tasks with agents in the page's order: "Needs you", "Working", "With an agent". */
const AGENT_GROUPS: readonly string[] = ["r:needs", "r:working", "r:other"];

/** The group of a task with agents, by the state of the agent that asks most of the person. */
const groupOf = (state: AgentState): string =>
  state === "waiting" ? "r:needs" : state === "working" ? "r:working" : "r:other";

/** The section the expanded task stays in: the one it was shown in, if it was in one of them. */
const heldIn = (held: HeldRow): string | undefined =>
  held.section !== undefined &&
  (AGENT_GROUPS.includes(held.section) || /^d:\d{4}-\d{2}-\d{2}$/.test(held.section))
    ? held.section
    : undefined;

const byRef = (a: TaskRow, b: TaskRow): number =>
  a.ref.localeCompare(b.ref, "en", { numeric: true });

/** Rows per read of the Trash: every page is read, so none falls behind. */
const PAGE = 200;

/**
 * The rows of the tasks in the Trash that the page places as it places a live task: those whose
 * row shows a run, every page of them, and `named`, which the Agent Monitor links an agent to.
 */
async function readTrashedWork(
  client: Client,
  named: readonly string[],
): Promise<Map<string, TaskRow>> {
  const found = new Map<string, TaskRow>();
  const add = (rows: readonly unknown[]): void => {
    for (const value of rows) {
      const row = taskRow(value);
      if (row !== undefined) found.set(row.id, row);
    }
  };
  let cursor: string | undefined;
  do {
    const page = await client.task.trash({
      working: true,
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    add(page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (let at = 0; at < named.length; at += PAGE) {
    add((await client.task.trash({ tasks: named.slice(at, at + PAGE), limit: PAGE })).rows);
  }
  return found;
}

/**
 * The tasks in the Trash that the page places as it places a live one (readTrashedWork): read at
 * once, again whenever the feed says a run, a launch or a task's place in the Trash changed or
 * brings a fresh snapshot, and when the monitor links an agent to another of them.
 */
function useTrashedWork(named: readonly string[]): ReadonlyMap<string, TaskRow> {
  const { api, live } = useContext(Session);
  const [rows, setRows] = useState<ReadonlyMap<string, TaskRow>>(new Map());
  const key = named.join(" ");
  useEffect(() => {
    const reads = new Latest();
    const asked = key === "" ? [] : key.split(" ");
    const read = (): void => {
      const newest = reads.begin("trash");
      readTrashedWork(api.client, asked).then(
        (found) => {
          if (newest()) setRows(found);
        },
        (error: unknown) => {
          live.failed(error);
        },
      );
    };
    read();
    return live.onChanges(({ changes, reset }) => {
      const touched = changes.some(
        (c) =>
          c.type === "run" ||
          c.type === "launch" ||
          (c.type === "task" && (c.changed.length === 0 || c.changed.includes("deleted"))),
      );
      if (reset || touched) read();
    });
  }, [api, live, key]);
  return rows;
}

export interface AgentsProps {
  readonly task?: string | undefined;
  readonly onExpand: (task: TaskRow | undefined, gone?: boolean) => void;
}

export function AgentsPage({ task, onExpand }: AgentsProps) {
  const t = useT();
  const { live } = useContext(Session);
  const edits = useEdits();
  const log = changeLogOf(live);
  const changes = useSyncExternalStore(log.subscribe, log.getEntries);
  const clock = useClock(false);
  const { tasks: open, asking } = useLive();
  const agents = useSyncExternalStore(live.agents.subscribe, live.agents.getState);
  const picture = agents.view?.picture ?? null;
  const named = useMemo(
    () =>
      linkedOutside(
        picture,
        live.spaceId,
        asking.size === 0 ? open : new Map([...asking, ...open]),
      ),
    [picture, live.spaceId, open, asking],
  );
  const trashed = useTrashedWork(named);
  // A finished task a question waits on is placed as an open one is, and so is a task in the
  // Trash an agent works on.
  const outside = useMemo(
    () => (trashed.size === 0 ? asking : new Map([...trashed, ...asking])),
    [asking, trashed],
  );
  const rows = useMemo(
    () => (outside.size === 0 ? open : new Map([...outside, ...open])),
    [open, outside],
  );
  const merged = useMemo(
    () => mergeAgents(picture, live.spaceId, rows),
    [picture, live.spaceId, rows],
  );
  // What the monitor put in a group is as old as its picture: muted while that is not current.
  const muted = useMemo(
    () =>
      agents.current
        ? new Set<string>()
        : new Set([...merged.tasks].flatMap(([id, placed]) => (placed.own ? [] : [id]))),
    [agents.current, merged],
  );
  const beneath = useCallback(
    (row: TaskRow) => {
      const listed = merged.tasks.get(row.id)?.agents ?? [];
      const asked = questionsWaiting(row) > 0;
      const removed = row.deleted_at !== undefined;
      if (listed.length === 0 && !asked && !removed) return undefined;
      // A run's card has its Stop; an agent in a terminal has none here, so the line says where.
      const terminal = listed.some((agent) => agent.started === "terminal");
      return (
        <>
          {removed ? (
            <span className={trash.where} data-part="agents-in-trash">
              {t(terminal ? "agents.inTrashTerminal" : "agents.inTrash")}
              <button
                type="button"
                className={trash.restore}
                data-part="restore"
                aria-label={t("trash.restoreLabel", { ref: row.ref })}
                onClick={() => {
                  edits.restore(row);
                }}
              >
                {t("trash.restore")}
              </button>
            </span>
          ) : null}
          {asked ? (
            <Questions
              row={row}
              onDismiss={(newest) => {
                edits.dismissQuestions(row, newest);
              }}
            />
          ) : null}
          {listed.length === 0 ? null : <TaskAgents agents={listed} current={agents.current} />}
        </>
      );
    },
    [merged, agents.current, edits, t],
  );
  const groups = useCallback<GroupsOf>(
    (tasks, held) => {
      // Each task in one section: its agents' group first, else the day of Recent of its newest
      // change.
      const sections = new Map<string, TaskRow[]>(AGENT_GROUPS.map((key) => [key, []]));
      const placed = new Set<string>();
      const put = (key: string, row: TaskRow): void => {
        if (placed.has(row.id)) return;
        placed.add(row.id);
        const list = sections.get(key);
        if (list === undefined) sections.set(key, [row]);
        else list.push(row);
      };
      // Nothing moves that did not change: TTasks' own rows first, in their order, then the rows
      // the monitor placed as their agents started, a new one last.
      const own = (row: TaskRow) => (merged.tasks.get(row.id)?.own === true ? 0 : 1);
      const age = (row: TaskRow) => merged.tasks.get(row.id)?.ageMs ?? -1;
      const withAgents = [
        ...tasks.values(),
        ...[...outside.values()].filter((r) => !tasks.has(r.id)),
      ]
        .filter((row) => merged.tasks.has(row.id))
        .sort((a, b) => own(a) - own(b) || (own(a) === 0 ? 0 : age(b) - age(a) || byRef(a, b)));
      for (const row of withAgents) {
        const state = merged.tasks.get(row.id)?.state;
        if (state !== undefined) put(groupOf(state), row);
      }
      for (const day of recentOf(changes, tasks, clock.timeZone)) {
        for (const row of day.tasks) put(`d:${day.date}`, row);
      }
      // The expanded task stays in the section it was shown in, at its place there, until it is
      // collapsed; one the list has not shown yet joins the top of the first section.
      const into = held === undefined ? undefined : heldIn(held);
      if (held !== undefined && (into !== undefined || !placed.has(held.task.id))) {
        for (const list of sections.values()) {
          const at = list.findIndex((r) => r.id === held.task.id);
          if (at >= 0) list.splice(at, 1);
        }
        const key = into ?? [...sections].find(([, list]) => list.length > 0)?.[0] ?? "d:";
        const list = sections.get(key) ?? [];
        list.splice(into === undefined ? 0 : Math.min(held.index ?? 0, list.length), 0, held.task);
        sections.set(key, list);
      }
      return groupsOf(sections, t, clock);
    },
    [changes, clock, t, merged, outside],
  );
  return (
    <div>
      <TaskList
        key="agents"
        view="agents"
        grouping="flat"
        filter={ANY}
        groups={groups}
        clock={clock}
        empty={t("view.empty.agents")}
        expand={task}
        onExpand={onExpand}
        muted={muted}
        beneath={beneath}
      />
      <Computer shown={merged.shown} />
    </div>
  );
}

/**
 * The questions agents asked that wait for the person, newest first, each in its own words:
 * answered by a note on the task, or set aside with Dismiss, which names the newest one shown so
 * that a question asked after it still waits.
 */
function Questions({
  row,
  onDismiss,
}: {
  readonly row: TaskRow;
  readonly onDismiss: (newest: string) => void;
}) {
  const t = useT();
  const questions = row.questions ?? [];
  const count = questionsWaiting(row);
  const more = count - questions.length;
  const newest = questions[0];
  if (newest === undefined) return null;
  return (
    <div className={styles.question} data-part="question">
      <div className={styles.asked}>
        {count > 1 ? <p className={styles.count}>{t("agents.questions", { count })}</p> : null}
        <ul>
          {questions.map((question) => (
            <li key={question.ref}>
              <p className={styles.asks}>{t("agents.asks", { by: question.by })}</p>
              <p className={styles.words} dir="auto">
                {question.text}
              </p>
            </li>
          ))}
        </ul>
        {more > 0 ? (
          <p className={styles.more}>{t("agents.questionsMore", { count: more })}</p>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.dismiss}
        data-part="dismiss-question"
        aria-label={t("agents.dismissLabel", { count, ref: row.ref })}
        onClick={(event) => {
          focusAfter(event.currentTarget);
          onDismiss(newest.ref);
        }}
      >
        {t("agents.dismiss")}
      </button>
    </div>
  );
}

/** The page's groups: the three of agents, then one per day of Recent, newest first. */
function groupsOf(
  sections: ReadonlyMap<string, readonly TaskRow[]>,
  t: Translate,
  clock: Clock,
): Group[] {
  const listed = (key: string) => sections.get(key) ?? [];
  const label = (key: string, title: string): Group[] =>
    listed(key).length === 0
      ? []
      : [{ key, kind: "label", title, sections: [{ key, tasks: listed(key) }] }];
  const days = [...sections.keys()]
    .filter((key) => key.startsWith("d:") && key !== "d:")
    .sort()
    .reverse()
    .flatMap((key) => {
      const date = key.slice(2);
      return label(
        key,
        date === clock.today
          ? t("row.today")
          : t("row.fullDate", {
              weekday: formatDay(date, clock.locale, { weekday: "long" }),
              day: Number(date.slice(8, 10)),
              month: formatDay(date, clock.locale, { month: "long" }),
            }),
      );
    });
  const loose = listed("d:");
  return [
    ...(loose.length === 0
      ? []
      : [{ key: "d:", kind: "flat" as const, sections: [{ key: "d:", tasks: loose }] }]),
    ...label("r:needs", t("agents.needsYou")),
    ...label("r:working", t("agents.working")),
    ...label("r:other", t("agents.other")),
    ...days,
  ];
}
