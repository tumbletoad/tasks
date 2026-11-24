// A view's task list (A5 3.5, 3.6, 3.15): the view's tasks, grouped as the view groups them (by
// area and project unless it says otherwise, Today's sections, Completed's months), drawn by the one list
// (list/List.tsx) and the one row (row/Row.tsx). The rows are read from the store's state and never
// copied: the list derives its items from the published rows and keeps no rows of its own.
//
// What it holds itself: which task is expanded (one at a time) and which row is current, the launch
// receipts of the tasks this tab follows, the rows an agent has just added (they fade in), and the
// screen reader's summary of agents' changes in the view (A5 3.15 items 7 and 10).
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Refused, requestId, type Instance, type Receipt, type Run } from "../api.ts";
import { useToast, type ToastAction } from "../app/frame.ts";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { starChange, statusChange, triageChange } from "../edit/change.ts";
import { useEditState, useEdits } from "../edit/useEdits.ts";
import { askFor, savedWords } from "../task/composer.ts";
import { areaSlots, groupTasks, type Group, type GroupTasks } from "../groups.ts";
import { useList, useT } from "../i18n/intl.tsx";
import { Latest } from "../latest.ts";
import { itemsOf, type RowItem } from "../list/items.ts";
import { List, type Place } from "../list/List.tsx";
import {
  busyByTask,
  folderRefusal,
  homeRefusal,
  instanceRefusal,
  MARKER_REASONS,
  markerWords,
  t3Refusal,
  type BusyOf,
  type FolderRefusal,
} from "../row/launch.ts";
import { readOnlyReason, readOnlyWhy } from "../edit/read-only.ts";
import { contextFor, type Grouping, type RowView } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import type { OpenWith, RowActions } from "../row/actions.ts";
import type { Clock } from "../row/dates.ts";
import { Row } from "../row/Row.tsx";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { rowOfFacts } from "../task/detail.ts";
import { mergeRuns, runRefusal, withStops } from "../task/runs.ts";
import css from "./TaskList.module.css";
import { openAsked, openName, runName, unansweredOpens, unansweredRuns } from "./unanswered.ts";

const styles = classes(css, ["line", "announce"]);

const NO_RECEIPTS: readonly Receipt[] = [];
const NO_RUNS: readonly Run[] = [];
/** What the page says of an Open its instance cannot do here (instanceRefusal). */
const REFUSED_WORDS = {
  not_for_space: "row.openNotForSpace",
  no_terminal: "row.openNoTerminal",
  own_home: "row.openOwnHome",
} as const;
/** How long a row an agent added keeps its accent (A5 3.20: 1.2 s). */
const FRESH_MS = 1_200;
/** Agents' changes are announced once the burst has been quiet this long (A5 3.15 item 10). */
const QUIET_MS = 2_000;
/**
 * What a working run says changes nothing in its record, so the runs of a task with one are read
 * again this often: how long it has said nothing stays true. A failed read is tried again as often:
 * what it would have brought may never be announced again.
 */
const WORKING_REREAD_MS = 60_000;
/** The waits before a failed read of busy is tried again, the last one repeating. */
const BUSY_RETRY_MS = [1_000, 2_000, 5_000, 15_000] as const;

/**
 * The service answered with a refusal (the page's `Refused`, or the generated client's error, both
 * with a code): nothing was done. A lost reply, or the service's own failure, may follow a change.
 */
function without(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(item);
  return next;
}

function refusedBy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code !== "internal";
}

/** The expanded task as the list last showed it: its group and its place in that group's list. */
export interface HeldRow {
  readonly task: TaskRow;
  readonly group?: string;
  /** The key of the section it was shown in (`Section.key`). */
  readonly section?: string;
  readonly index?: number;
}

/**
 * A view's groups from the live rows (A7 3.12: a view hands its rows to the list). `held` is the
 * expanded task, which stays where it is until it is collapsed (A5 3.15), whatever an update did.
 */
export type GroupsOf = (
  tasks: ReadonlyMap<string, TaskRow>,
  held: HeldRow | undefined,
) => readonly Group[];

export interface TaskListProps {
  /** The view the list is shown in: what its rows leave out (A5 3.6 `ctx`). */
  readonly view: RowView;
  /** What the view's grouping states, so its rows leave it out (A5 3.6). Default: by area. */
  readonly grouping?: Grouping;
  /**
   * Which open tasks the view may hold: the rows an agent adds there fade in, and its changes are
   * announced. Without `groups`, also what the list shows, grouped by area and project.
   */
  readonly filter: (task: TaskRow) => boolean;
  /** How the view groups the tasks `filter` gives it (A5 3.5). Default: by area and project. */
  readonly group?: GroupTasks;
  /** The view's own groups, from every row (Today's sections, Completed's months). */
  readonly groups?: GroupsOf;
  /** The view's clock, when the view reads it too (Today's sections and strip). */
  readonly clock?: Clock;
  /** The line an empty view shows; none while the view does not know yet (a query on its way). */
  readonly empty: string | undefined;
  /**
   * Rows checked off here stay, checked, after their hold: the list's rows are a search's, which
   * do not move under the pointer.
   */
  readonly keepsFinished?: boolean;
  /**
   * The task the URL names (a reference or an ID): expanded once it is found. In the live rows,
   * or else read with `task.get` and injected (A5 3.3): a task of another lifecycle, or one the
   * view's filter leaves out. Undefined: none is expanded.
   */
  readonly expand?: string | undefined;
  /**
   * The person expanded a task or collapsed it: the page puts it in the URL. `gone`: the URL's
   * task does not exist, and the URL drops it.
   */
  readonly onExpand?: (task: TaskRow | undefined, gone?: boolean) => void;
  /**
   * The expanded task was read again, apart from the feed: a view that keeps its own rows (a
   * search's) shows the task as the read found it.
   */
  readonly onRead?: (task: TaskRow) => void;
  /** Tasks whose place in the view comes from a picture that is not current: their rows are muted. */
  readonly muted?: ReadonlySet<string>;
  /** What a task's row shows beneath its line, such as the agents that work on it. */
  readonly beneath?: (task: TaskRow) => ReactNode;
}

export function TaskList({
  view,
  grouping = "area",
  filter,
  group = groupTasks,
  groups: groupsOf,
  clock: viewClock,
  empty,
  keepsFinished = false,
  expand: wantedRef,
  onExpand,
  onRead,
  muted,
  beneath,
}: TaskListProps) {
  const t = useT();
  const list = useList();
  const say = useToast();
  const { api, live } = useContext(Session);
  const state = useLive();
  const edits = useEdits();
  // Rows checked off, or completed by others, stay where they are for the hold (A5 3.12).
  const { leaving: holding } = useEditState();
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  // The expanded one stays as the card shows it (below), with its newest data.
  const tasks = useMemo(() => {
    let merged: Map<string, TaskRow> | undefined;
    for (const [id, entry] of holding) {
      if (state.tasks.has(id) || id === expanded) continue;
      merged ??= new Map(state.tasks);
      merged.set(id, entry.row);
    }
    return merged ?? state.tasks;
  }, [state.tasks, holding, expanded]);
  const [receipts, setReceipts] = useState<ReadonlyMap<string, readonly Receipt[]>>(new Map());
  /** What busies each task's agent apps on this machine, as the service last said. */
  const [busy, setBusy] = useState<ReadonlyMap<string, BusyOf>>(new Map());
  const busyReads = useRef(new Latest());
  /** A failed read of busy is tried again: the timer and how many tries failed in a row. */
  const busyRetry = useRef<{ timer?: ReturnType<typeof setTimeout>; failed: number }>({
    failed: 0,
  });
  /** The runs of the tasks the tab follows, oldest first, as the service last said. */
  const [runs, setRuns] = useState<ReadonlyMap<string, readonly Run[]>>(new Map());
  /**
   * The runs whose Stop is on its way, each with its version when Stop was pressed and how many
   * reads of runs had begun then.
   */
  const [stops, setStops] = useState<
    ReadonlyMap<string, { readonly version: number; readonly reads: number }>
  >(new Map());
  /** How many reads of runs have begun. */
  const runReadsBegun = useRef(0);
  const runReads = useRef(new Latest());
  /** The tasks whose last read of their runs failed. */
  const [runsFailed, setRunsFailed] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  /** The URL's task, read with `task.get` because the live rows do not hold it. */
  const [injected, setInjected] = useState<TaskRow | undefined>(undefined);
  /** The tasks whose receipts the tab follows: the expanded one, and every one it launched. */
  const watched = useRef(new Set<string>());
  const receiptReads = useRef(new Latest());
  /** This tab's Opens still waiting for their answer, by task and instance. */
  const clicks = useRef(new Map<string, Promise<Receipt | undefined>>());
  const changed = useRef(onExpand);
  changed.current = onExpand;
  /** The expanded task's row as last seen: it stays while expanded, whatever the update did. */
  const held = useRef<TaskRow | undefined>(undefined);
  /** What the callbacks read: one object for every row, for good. */
  const latest = useRef<{
    expanded: string | undefined;
    unresolved: string | undefined;
    today: string;
  }>({
    expanded: undefined,
    unresolved: undefined,
    today: "",
  });
  /** The URL's task whose `task.get` is on its way: asked once, not at every frame. */
  const asking = useRef<string | undefined>(undefined);
  /** The URL's task this list has applied, or written itself. */
  const handled = useRef<string | undefined>(wantedRef === undefined ? undefined : "");
  /** The URL's task as this render reads it. */
  const wanted = useRef(wantedRef);
  wanted.current = wantedRef;
  /**
   * The URL's task the person has just left by expanding or collapsing a row: until the router
   * puts the new URL in place, a frame that renders with the old one must not apply it again.
   */
  const leaving = useRef<{ ref: string | undefined } | undefined>(undefined);
  /** The URL's `task.get`: the newest one applies, and the person's own choice outdates it. */
  const lookups = useRef(new Latest());
  /** The expanded task's read after a fresh snapshot left it out: the newest one applies. */
  const rereads = useRef(new Latest());
  /**
   * The expanded task a fresh snapshot left out, until a read or the feed says how it is now; and
   * whether the last read of it failed.
   */
  const [unresolved, setUnresolved] = useState<{ id: string; failed: boolean } | undefined>();

  // The expanded task's newest row: live, else the injected one, else the last one seen.
  const expandedRow =
    expanded === undefined
      ? undefined
      : (state.tasks.get(expanded) ??
        (injected?.id === expanded ? injected : undefined) ??
        holding.get(expanded)?.row ??
        (held.current?.id === expanded ? held.current : undefined));

  /** Where the expanded row was shown last: its group and its place there. */
  const place = useRef<{ id: string; group: string; section: string; index: number } | undefined>(
    undefined,
  );

  // The view's rows, grouped, as one sequence of items. Recomputed when the published rows change.
  // An expanded task stays where it is until it is collapsed, even when an update takes it out
  // of the view (A5 3.1 item 7), and the URL's task joins its group when the view leaves it out.
  // Only the expanded task joins: the injected row is that task's row while it is expanded, and
  // the live row wins over it as soon as the store holds the task.
  const items = useMemo(() => {
    let groups: readonly Group[];
    if (groupsOf !== undefined) {
      const was = place.current;
      const held =
        expandedRow === undefined
          ? undefined
          : {
              task: expandedRow,
              ...(was?.id === expandedRow.id
                ? { group: was.group, section: was.section, index: was.index }
                : {}),
            };
      groups = groupsOf(tasks, held);
    } else {
      const shown = [...tasks.values()].filter(filter);
      if (expandedRow !== undefined && !shown.some((task) => task.id === expandedRow.id)) {
        shown.push(expandedRow);
      }
      groups = group(shown, state.areas.values(), state.projects.values());
    }
    return itemsOf(groups, state.areas, state.projects, areaSlots(state.areas.values()));
  }, [tasks, state.areas, state.projects, filter, group, groupsOf, expandedRow]);

  // Where the expanded row is now, for the next update (a view's own groups keep it there). Taken
  // after the commit, so a render React throws away (a transition it interrupted, a StrictMode
  // second render) never moves the place the next update keeps the row at.
  const shownAt = expanded === undefined ? undefined : items.index.get(expanded);
  const shownItem = shownAt === undefined ? undefined : items.items[shownAt];
  useLayoutEffect(() => {
    held.current = expandedRow;
    if (shownItem?.kind === "row") {
      place.current = {
        id: shownItem.key,
        group: shownItem.group,
        section: shownItem.sectionKey,
        index: shownItem.posinset - 1,
      };
    } else if (expanded === undefined) {
      place.current = undefined;
    }
  });

  const timed = useMemo(
    () => items.items.some((item) => item.kind === "row" && item.task.due_at !== undefined),
    [items],
  );
  const ownClock = useClock(timed && viewClock === undefined);
  const clock = viewClock ?? ownClock;
  const efforts = state.scales.efforts;
  const ctx = useMemo(
    () => contextFor(view, grouping, clock, efforts),
    [view, grouping, clock, efforts],
  );
  const finishedCtx = useMemo(
    () => contextFor("completed", grouping, clock, efforts),
    [grouping, clock, efforts],
  );

  const loadReceipts = useCallback(
    (task: string) => {
      const newest = receiptReads.current.begin(task);
      api
        .receipts(task)
        .then((list) => {
          // An older read that answers late never replaces a newer list.
          if (newest()) setReceipts((known) => new Map(known).set(task, list));
        })
        .catch((error: unknown) => {
          live.failed(error);
          // Read, if only as nothing: the card draws its thread all the same.
          setReceipts((known) => (known.has(task) ? known : new Map(known).set(task, [])));
        });
    },
    [api, live],
  );

  // A read that fails is tried again while the tab is live, so Open never stays held, or offered,
  // on what a tab last heard. An offline tab reads again once it is live.
  const loadBusy = useCallback(() => {
    const retry = busyRetry.current;
    const read = (): void => {
      clearTimeout(retry.timer);
      const newest = busyReads.current.begin("busy");
      api
        .busy()
        .then((list) => {
          retry.failed = 0;
          if (newest()) setBusy((known) => busyByTask(list, known));
        })
        .catch((error: unknown) => {
          if (live.failed(error) || !newest()) return;
          const wait = BUSY_RETRY_MS[Math.min(retry.failed, BUSY_RETRY_MS.length - 1)];
          retry.failed += 1;
          retry.timer = setTimeout(() => {
            if (live.getState().phase === "live") read();
          }, wait);
        });
    };
    read();
  }, [api, live]);

  // Whenever the tab is live, on mount and again after it was offline, it reads what busies the
  // agent apps: a launch may have started or ended while it heard nothing.
  const phase = state.phase;
  useEffect(() => {
    if (phase === "live") loadBusy();
  }, [phase, loadBusy]);
  useEffect(() => {
    const retry = busyRetry.current;
    return () => {
      clearTimeout(retry.timer);
    };
  }, []);

  const loadRuns = useCallback(
    (task: string) => {
      const newest = runReads.current.begin(task);
      const begun = ++runReadsBegun.current;
      api
        .runs(task)
        .then((list) => {
          if (!newest()) return;
          setRuns((known) => new Map(known).set(task, mergeRuns(known.get(task) ?? [], list)));
          setRunsFailed((known) => (known.has(task) ? without(known, task) : known));
          // A read that left after a Stop and still finds its run waiting or working: the Stop may
          // never arrive, so it is offered again.
          setStops((known) => {
            const unstopped = list.filter(
              (run) =>
                (run.state === "queued" || run.state === "running") &&
                (known.get(run.id)?.reads ?? begun) < begun,
            );
            if (unstopped.length === 0) return known;
            const next = new Map(known);
            for (const run of unstopped) next.delete(run.id);
            return next;
          });
        })
        .catch((error: unknown) => {
          live.failed(error);
          if (!newest()) return;
          // The thread draws all the same, and says what it shows of the runs may be old.
          setRuns((known) => (known.has(task) ? known : new Map(known).set(task, [])));
          setRunsFailed((known) => (known.has(task) ? known : new Set(known).add(task)));
        });
    },
    [api, live],
  );

  // The minute reads again the runs of every task with a working run, and while its card is open
  // what a read failed to bring: the task's runs, or the task a fresh snapshot left out. Keyed by
  // what it reads, not by each read: a read of another task's runs must not start the minute again.
  const again = useMemo(
    () =>
      [
        ...[...runs]
          .filter(
            ([task, list]) =>
              (runsFailed.has(task) && task === expanded) ||
              list.some((run) => run.state === "running"),
          )
          .map(([task]) => `runs:${task}`),
        ...(unresolved?.failed === true && unresolved.id === expanded
          ? [`task:${unresolved.id}`]
          : []),
      ]
        .sort()
        .join(" "),
    [runs, runsFailed, expanded, unresolved],
  );

  // A launch event refreshes what busies the agent apps, for every row, and the receipts of its
  // task, which the tab follows from then on: a tile mirrors a launch made in another tab or at the
  // terminal. A run event refreshes the runs of a task the tab follows: every tab, and a reload,
  // shows a run as the service has it. A fresh snapshot refreshes all.
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        if (reset || changes.some((change) => change.type === "launch")) loadBusy();
        const named = new Set<string>(reset ? watched.current : []);
        const ran = new Set<string>(reset ? watched.current : []);
        for (const change of changes) {
          if (change.type === "run") {
            if (change.task !== undefined && watched.current.has(change.task)) ran.add(change.task);
            continue;
          }
          if (change.type !== "launch") continue;
          // A launch the feed does not tie to a task refreshes every task the tab follows.
          if (change.task === undefined) for (const task of watched.current) named.add(task);
          else named.add(change.task);
        }
        for (const task of named) {
          watched.current.add(task);
          loadReceipts(task);
        }
        for (const task of ran) loadRuns(task);
      }),
    [live, loadBusy, loadReceipts, loadRuns],
  );

  const readOut = useRef(onRead);
  readOut.current = onRead;

  /**
   * Reads the expanded task a fresh snapshot left out: the card shows it as the read found it, or
   * closes and says so when it no longer exists. Until then it is unresolved: its card says so and
   * offers nothing. Only the newest read applies, and none once the feed said something newer.
   */
  const readAgain = useCallback(
    (id: string) => {
      const newest = rereads.current.begin("expanded");
      const applies = () => newest() && latest.current.expanded === id;
      setUnresolved((known) => (known?.id === id ? known : { id, failed: false }));
      api.client.task
        .get({ task: id })
        .then((answer) => {
          if (!applies() || answer.view !== "digest") return;
          const { areas, projects } = live.getState();
          const row = rowOfFacts(answer.task, areas, projects, latest.current.today);
          setUnresolved(undefined);
          setInjected(row);
          readOut.current?.(row);
        })
        .catch((error: unknown) => {
          if (live.failed(error) || !applies()) return;
          if ((error as { code?: unknown } | null)?.code !== "not_found") {
            setUnresolved({ id, failed: true });
            return;
          }
          setUnresolved(undefined);
          setExpanded(undefined);
          setInjected(undefined);
          say(t("task.gone"));
          changed.current?.(undefined, true);
        });
    },
    [api, live, say, t],
  );

  useEffect(() => {
    if (again === "") return;
    const timer = setInterval(() => {
      for (const key of again.split(" ")) {
        const [kind, task = ""] = key.split(":");
        if (kind === "task") readAgain(task);
        else loadRuns(task);
      }
    }, WORKING_REREAD_MS);
    return () => {
      clearInterval(timer);
    };
  }, [again, loadRuns, readAgain]);

  // An update that takes the expanded task out of the live rows (completed, archived) carries its
  // newest row: the card shows it until it is collapsed, as an injected row (A5 3.4, 3.15). A fresh
  // snapshot that leaves it out carries none: it is read again. Whatever the feed says of the task
  // is newer than a read on its way.
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        const id = latest.current.expanded;
        if (id === undefined) return;
        const inStore = live.getState().tasks.has(id);
        if (reset && !inStore) {
          readAgain(id);
          return;
        }
        let named = reset;
        let left: TaskRow | undefined;
        for (const change of changes) {
          if (change.type !== "task" || change.id !== id) continue;
          named = true;
          left = inStore ? undefined : (change.after as TaskRow | undefined);
        }
        if (!named) return;
        if (inStore || left !== undefined) {
          rereads.current.begin("expanded");
          setUnresolved(undefined);
        } else if (latest.current.unresolved === id) {
          readAgain(id);
        }
        if (left !== undefined) setInjected(left);
      }),
    [live, readAgain],
  );

  // Rows an agent adds fade in; agents' changes to the view's tasks are announced once the burst
  // settles, by actor ("3 tasks updated by Codex").
  const inView = useRef(filter);
  inView.current = filter;

  // A task someone else completes while the view shows it strikes through, says who, and leaves
  // after the hold (A5 3.12). This tab's own check-off holds already.
  useEffect(
    () =>
      live.onChanges(({ changes }) => {
        for (const change of changes) {
          if (change.type !== "task" || change.before === undefined) continue;
          const before = change.before as TaskRow;
          const after = change.after as TaskRow | undefined;
          if (before.lifecycle !== "active" || after === undefined) continue;
          if (after.lifecycle === "active" || after.deleted_at !== undefined) continue;
          if (!inView.current(before)) continue;
          // The tab's own write that it holds no row for yet (a redo) holds without an actor.
          const by = edits.isMine(change.request_id)
            ? undefined
            : change.actor.kind === "human"
              ? "user"
              : change.actor.label;
          edits.hold(before, by, Date.now());
        }
      }),
    [live, edits],
  );
  useEffect(() => {
    const burst = new Map<string, Set<string>>();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = live.onChanges(({ changes }) => {
      const added: string[] = [];
      for (const change of changes) {
        const { kind, label } = change.actor;
        if (kind === "human" || kind === "system" || change.task === undefined) continue;
        // The store has published this frame's rows before it tells its listeners.
        const task = live.getState().tasks.get(change.task);
        if (task === undefined || !inView.current(task)) continue;
        if (change.type === "task" && change.created) added.push(change.task);
        const tasks = burst.get(label) ?? new Set<string>();
        tasks.add(change.task);
        burst.set(label, tasks);
      }
      if (added.length > 0) {
        setFresh((known) => new Set([...known, ...added]));
        const timer = setTimeout(() => {
          timers.delete(timer);
          setFresh((known) => {
            const next = new Set(known);
            for (const id of added) next.delete(id);
            return next;
          });
        }, FRESH_MS);
        timers.add(timer);
      }
      if (burst.size > 0) {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          const lines = [...burst].map(([actor, tasks]) =>
            t("list.updated", { count: tasks.size, actor }),
          );
          burst.clear();
          setAnnouncement(lines.join("\n"));
        }, QUIET_MS);
      }
    });
    return () => {
      stop();
      clearTimeout(quiet);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [live, t]);

  const expandTask = useCallback(
    (task: TaskRow) => {
      setExpanded(task.id);
      setCurrent(task.id);
      // An injected row belongs to its expansion: another task's expansion ends it. A row the live
      // store does not hold (a finished task in Completed) is kept as the expanded one's, so it
      // stays where it is if the view's next read leaves it out (A5 3.3).
      const inStore = live.getState().tasks.has(task.id);
      setInjected((known) => (known?.id === task.id ? known : inStore ? undefined : task));
      setUnresolved((known) => (known?.id === task.id ? known : undefined));
      watched.current.add(task.id);
      loadReceipts(task.id);
      loadRuns(task.id);
    },
    [loadReceipts, loadRuns, live],
  );

  /**
   * The person expanded or collapsed a row: that is the URL's task now (`ref`). A lookup of the
   * URL's earlier task that is still on its way is outdated, and the earlier URL, until the
   * router replaces it, is not applied again.
   */
  const chosen = useCallback((ref: string | undefined) => {
    handled.current = ref;
    lookups.current.begin("target");
    asking.current = undefined;
    leaving.current = wanted.current === ref ? undefined : { ref: wanted.current };
  }, []);

  // The URL's task (a link, `ttasks open <task>`, a reload, Back and Forward) expands once it is
  // found: in the live rows, or read with `task.get` once the rows are live and do not hold it.
  // A URL without a task collapses. A task that does not exist leaves the URL with a toast. Each
  // URL task is applied once (`handled`): the URL this list wrote itself, after the person
  // expanded or collapsed a row, is already applied, so a frame in between never undoes a click.
  useEffect(() => {
    if (leaving.current !== undefined) {
      if (wantedRef === leaving.current.ref) return;
      leaving.current = undefined;
    }
    if (wantedRef === handled.current) return;
    if (wantedRef === undefined) {
      handled.current = undefined;
      asking.current = undefined;
      setExpanded(undefined);
      setInjected(undefined);
      return;
    }
    const matches = (row: TaskRow) => row.ref === wantedRef || row.id === wantedRef;
    const row =
      [...state.tasks.values()].find(matches) ??
      (injected !== undefined && matches(injected) ? injected : undefined);
    if (row !== undefined) {
      handled.current = wantedRef;
      if (latest.current.expanded !== row.id) expandTask(row);
      return;
    }
    if (state.phase !== "live" || asking.current === wantedRef) return;
    asking.current = wantedRef;
    const newest = lookups.current.begin("target");
    // An answer applies only while it is the newest lookup and the URL still names its task: the
    // person may have chosen another row, or gone Back, while it was on its way.
    const applies = () => newest() && wanted.current === wantedRef;
    const settled = () => {
      if (asking.current === wantedRef) asking.current = undefined;
    };
    const { areas, projects } = state;
    api.client.task
      .get({ task: wantedRef })
      .then((read) => {
        settled();
        if (!applies() || read.view !== "digest") return;
        handled.current = wantedRef;
        const found = rowOfFacts(read.task, areas, projects, latest.current.today);
        setInjected(found);
        expandTask(found);
      })
      .catch((error: unknown) => {
        if (live.failed(error)) return;
        settled();
        if (!applies()) return;
        handled.current = wantedRef;
        say(t("task.gone"));
        changed.current?.(undefined, true);
      });
  }, [wantedRef, state, injected, api, live, say, t, expandTask]);

  /** Collapses the expanded task; an injected one leaves with it (its route is left). */
  const collapse = useCallback(() => {
    chosen(undefined);
    setExpanded(undefined);
    setInjected(undefined);
    setUnresolved(undefined);
    changed.current?.(undefined);
  }, [chosen]);

  /** The click's receipt shows at once, unless a list already holds it: that one is newer. */
  const shown = useCallback(
    (task: TaskRow, receipt: Receipt) => {
      setReceipts((known) => {
        const list = known.get(task.id) ?? [];
        if (list.some((r) => r.id === receipt.id)) return known;
        return new Map(known).set(task.id, [...list, receipt]);
      });
      loadReceipts(task.id);
    },
    [loadReceipts],
  );

  /**
   * A run as the service just answered for it shows at once, in its place among the task's runs,
   * unless a newer read has it further along; the task's runs are read again.
   */
  const showRun = useCallback(
    (task: string, run: Run, reload = true) => {
      setRuns((known) => {
        const list = known.get(task) ?? [];
        const at = list.findIndex((r) => r.id === run.id);
        if (at < 0) return new Map(known).set(task, [...list, run]);
        if ((list[at]?.version ?? -1) > run.version) return known;
        const next = [...list];
        next[at] = run;
        return new Map(known).set(task, next);
      });
      if (reload) loadRuns(task);
    },
    [loadRuns],
  );

  /** Each task's last Open refused on its folder, until an Open of it goes through. */
  const [refusals, setRefusals] = useState<ReadonlyMap<string, FolderRefusal>>(new Map());
  const refuse = useCallback((task: string, refused: FolderRefusal | undefined) => {
    setRefusals((known) => {
      if (known.get(task) === refused) return known;
      const next = new Map(known);
      if (refused === undefined) next.delete(task);
      else next.set(task, refused);
      return next;
    });
  }, []);

  /**
   * Puts a brief on the clipboard, in the person's click (A4 3.4.6). True once it is there. `then`
   * is said after the copy's outcome, in the same toast when the copy failed, so neither hides it.
   */
  const toClipboard = useCallback(
    (text: string, pack = false, then?: string): Promise<boolean> =>
      navigator.clipboard.writeText(text).then(
        () => {
          say(t(pack ? "row.packCopied" : "row.copied"));
          if (then !== undefined) say(then);
          return true;
        },
        () => {
          say(then === undefined ? t("row.copyFailed") : `${t("row.copyFailed")} ${then}`);
          return false;
        },
      ),
    [say, t],
  );

  // The row actions read the latest state through a ref: one object for every row, for good.
  latest.current = { expanded, unresolved: unresolved?.id, today: clock.today };
  const actions = useMemo<RowActions>(() => {
    // A T3 launch's thread, brought up in T3 Code: its brief too when that never came up.
    const openInT3 = (launch: string): void => {
      api.t3("open", launch).then(
        ({ opened }) => {
          if (opened !== true) say(t("row.t3NotUp"));
        },
        (error: unknown) => {
          if (!live.failed(error)) say(t("row.t3NotUp"));
        },
      );
    };
    // What T3 Code's refusal offers: Start when it does not run (Pair needs its server), Pair when
    // TTasks is not paired, or the pairing ended or allows too little.
    const t3Next = (why: string): ToastAction | undefined => {
      const act =
        why === "not_running"
          ? "start"
          : why === "not_paired" || why === "reconnect" || why === "pairing_denied"
            ? "pair"
            : undefined;
      if (act === undefined) return undefined;
      const answer = act === "start" ? "row.t3Starting" : "row.t3Pairing";
      return {
        label: { id: act === "start" ? "row.t3Start" : "row.t3Pair" },
        run: () => {
          api.t3(act).then(
            ({ opened }) => {
              say(t(answer, { opened: opened === true ? "yes" : String(opened) }));
            },
            (error: unknown) => {
              if (!live.failed(error)) say(t(answer, { opened: "no" }));
            },
          );
        },
      };
    };
    return {
      toggle: (task) => {
        if (latest.current.expanded === task.id) {
          collapse();
        } else {
          chosen(task.ref);
          expandTask(task);
          changed.current?.(task);
        }
      },
      // A tile whose session runs: the row expands, and stays expanded.
      expand: (task) => {
        if (latest.current.expanded !== task.id) {
          chosen(task.ref);
          expandTask(task);
          changed.current?.(task);
        }
      },
      // Open (A4's `launch.open`). An app that takes the brief by paste (Codex's assisted open)
      // gets it on the clipboard too.
      // A folder whose marker says it may be another one opens only when the person says so: the
      // toast asks, and its action opens it there and marks it. The composer's words stay in its
      // field until then. Once the service saved them on the task the field clears, as for Note.
      // An Open without an answer may have saved them and opened: until the service answers, the
      // same Open (task, instance and what it carries, "Open anyway" included) carries the same
      // request ID, also after a reload and from another tab, so it neither saves the words twice
      // nor opens a second window. An Open the service answers with a session that already runs
      // starts nothing: the read of busy shows it Running.
      open: (
        task: TaskRow,
        instance: Instance,
        { text, draft, request, another = false }: OpenWith = {},
      ) => {
        const key = `open\n${task.id}\n${instance.key}`;
        const name = openName(live.spaceId ?? "", task.id, instance.key);
        const asked = openAsked(another, text, request);
        const launch = (markFolder: boolean): Promise<Receipt | undefined> => {
          watched.current.add(task.id);
          const id = unansweredOpens.idFor(name, asked);
          return api
            .openLaunch(task.id, instance.key, id, {
              markFolder,
              another,
              ...(text === undefined ? {} : { text }),
              ...(request === undefined ? {} : { request }),
            })
            .then(async (opened) => {
              const { receipt, copy } = opened;
              unansweredOpens.answered(name, id);
              refuse(task.id, undefined);
              shown(task, receipt);
              loadBusy();
              const space = live.spaceId;
              if (text !== undefined && space !== undefined && opened.note !== undefined) {
                savedWords(space, task.id, draft ?? text);
              }
              // What this way of opening could not carry is said before the person sends anything.
              // A second click while the first was opening got that launch: its words are a note.
              const said = [
                ...(opened.leftOut.length > 0
                  ? [
                      t("row.openedWithout", {
                        label: instance.label,
                        what: list(opened.leftOut.map((code) => t("row.leftOut", { what: code }))),
                      }),
                    ]
                  : []),
                ...(opened.text === "note"
                  ? [t("row.openedEarlier", { label: instance.label })]
                  : []),
              ];
              const then = said.length === 0 ? undefined : said.join(" ");
              // T3 Code refused before making a thread: why, and what to do.
              if (
                receipt.state === "failed" &&
                (receipt.reason === "model_unavailable" || receipt.reason === "pairing_denied")
              ) {
                say(
                  t("row.openT3", { why: receipt.reason, label: instance.label }),
                  t3Next(receipt.reason),
                );
              }
              // T3 Code made the thread and did not come forward: the same thread, brought up.
              if (opened.linkOpened === false) {
                say(t("row.t3NotUp"), {
                  label: { id: "row.openInT3" },
                  run: () => {
                    openInT3(receipt.id);
                  },
                });
              }
              // The app takes the brief by paste: it opens without it when the copy failed.
              if (copy !== undefined)
                return (await toClipboard(copy, false, then)) ? receipt : undefined;
              if (then !== undefined) say(then);
              return receipt;
            })
            .catch((error: unknown) => {
              const answered = refusedBy(error);
              if (answered) unansweredOpens.refused(name, id);
              if (live.failed(error)) return undefined;
              if (!answered) {
                say(t("row.openUnanswered", { label: instance.label }));
                loadReceipts(task.id);
                return undefined;
              }
              // A space that takes no change: why, and no Try again, which could not work.
              const readOnly = readOnlyReason(error);
              if (readOnly !== undefined) {
                refuse(task.id, undefined);
                say(t("row.openReadOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) }));
                return undefined;
              }
              // Its agent could not use the tools in this space: Settings is where that changes.
              const home = homeRefusal(error);
              if (home !== undefined) {
                refuse(task.id, undefined);
                say(
                  t("row.openOtherSpace", {
                    label: instance.label,
                    space: home.works ?? t("apps.otherSpace"),
                  }),
                );
                return undefined;
              }
              // T3 Code cannot open it now: why, and Start or Pair where they help.
              const t3Why = t3Refusal(error);
              if (t3Why !== undefined) {
                refuse(task.id, undefined);
                say(t("row.openT3", { why: t3Why, label: instance.label }), t3Next(t3Why));
                return undefined;
              }
              const cannot = instanceRefusal(error);
              if (cannot !== undefined) {
                refuse(task.id, undefined);
                say(
                  t(REFUSED_WORDS[cannot], {
                    label: instance.label,
                  }),
                );
                return undefined;
              }
              const found = folderRefusal(error);
              if (found === undefined) {
                refuse(task.id, undefined);
                say(t("row.openFailed"));
                return undefined;
              }
              // The expanded task's folder line says what was found and offers the ways on: use
              // this folder (a marker's question), or choose another. The toast says it once.
              const marker = MARKER_REASONS.has(found.reason);
              const refused: FolderRefusal = marker
                ? {
                    ...found,
                    anyway: () => {
                      void launch(true);
                    },
                  }
                : found;
              refuse(task.id, refused);
              const chooseAnother = {
                label: { id: "row.chooseFolder" } as const,
                run: () => {
                  refuse(task.id, { ...refused, choose: true });
                  if (latest.current.expanded !== task.id) {
                    chosen(task.ref);
                    expandTask(task);
                    changed.current?.(task);
                  }
                },
              };
              if (marker) {
                say(t("row.openMarker", markerWords(refused)), {
                  label: { id: "row.openAnyway" },
                  run: () => {
                    void launch(true);
                  },
                });
              } else if (refused.reason === "other_machine") {
                say(t("row.openElsewhere"), chooseAnother);
              } else if (refused.folder === undefined) {
                say(t("row.openWorkFolder"));
              } else {
                say(
                  t("row.openFolder", { reason: refused.reason, folder: refused.folder }),
                  chooseAnother,
                );
              }
              return undefined;
            });
        };
        // A click while this tab's Open of the same task and agent waits for its answer is that
        // same Open.
        const waiting = clicks.current.get(key);
        if (waiting !== undefined) return waiting;
        const first = launch(false).finally(() => clicks.current.delete(key));
        clicks.current.set(key, first);
        return first;
      },
      // Copy (A4 3.4.6): the pointer brief, as a launch of its own whose reference an agent redeems.
      // Shift+Copy: the context pack, for an app without the tools (A4 3.15.5).
      copy: (task, pack = false, text) => {
        watched.current.add(task.id);
        return api
          .openLaunch(task.id, undefined, requestId(), {
            pack,
            ...(text === undefined ? {} : { text }),
          })
          .then(({ receipt, copy }) => {
            shown(task, receipt);
            return copy === undefined ? false : toClipboard(copy, pack);
          })
          .catch((error: unknown) => {
            // The service made no brief: nothing reached the clipboard to be refused there.
            if (live.failed(error)) return false;
            const readOnly = readOnlyReason(error);
            say(
              readOnly === undefined
                ? t("row.copyNotMade")
                : t("row.copyReadOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) }),
            );
            return false;
          });
      },
      // The folder opens on the computer the service runs on: the page is served there only, and
      // the toast names that computer for a page looked at through a forwarded port.
      folder: (task) => {
        api.showFolder(task.id).then(
          ({ opened, machine }) => {
            say(t("row.folderShown", { machine: machine ?? "", opened: opened ? "yes" : "no" }));
          },
          (error: unknown) => {
            if (live.failed(error)) return;
            const refused = folderRefusal(error);
            say(t("row.folderNotShown", { reason: refused?.reason ?? "other" }));
          },
        );
      },
      openInT3,
      // Run: the service queues the run and answers at once; the thread shows it from then on,
      // and the feed brings each of its steps. A refusal starts nothing and says why where the
      // person clicked; the folder line says it too when the folder is the reason. Without an
      // answer, or with the service's internal failure, the run may have been queued: until the
      // service answers it, also after a reload, the same Run carries the same request ID, so the
      // service gives that run back instead of starting a second.
      run: (task, instance, text) => {
        watched.current.add(task.id);
        const asked = `${instance.key}\n${text ?? ""}`;
        const name = runName(live.spaceId ?? "", task.id);
        const id = unansweredRuns.idFor(name, asked);
        return api
          .startRun(task.id, instance.key, id, text)
          .then((run) => {
            const again = unansweredRuns.again(name, id);
            unansweredRuns.answered(name, id);
            refuse(task.id, undefined);
            showRun(task.id, run);
            // A press again answered with a run that already ended: that request was taken
            // before. The words stay, and the next press is a new run.
            if (again && run.ended_at !== null) {
              say(t("run.alreadyTaken"));
              return undefined;
            }
            return run;
          })
          .catch((error: unknown) => {
            const refusedHere = error instanceof Refused && error.code !== "internal";
            if (refusedHere) unansweredRuns.refused(name, id);
            if (live.failed(error)) return undefined;
            if (!refusedHere) {
              say(t("run.unanswered"));
              loadRuns(task.id);
              return undefined;
            }
            const readOnly = readOnlyReason(error);
            if (readOnly !== undefined) {
              say(t("run.readOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) }));
              return undefined;
            }
            const refused = runRefusal(error);
            if (refused.reason === "folder_missing" && refused.folder !== undefined) {
              refuse(task.id, { reason: "path_missing", folder: refused.folder });
            }
            say(t("run.refused", { ...refused.words, label: instance.label }));
            return undefined;
          });
      },
      // Stop answers at once: the entry says it is stopping until the service answers, and the
      // record then says what ended. Without an answer the Stop may have arrived: the run shows as
      // the service last said, with its Stop, and is read again.
      stop: (task, run) => {
        const reads = runReadsBegun.current;
        setStops((known) => new Map(known).set(run.id, { version: run.version, reads }));
        const answered = () => {
          setStops((known) => {
            const next = new Map(known);
            next.delete(run.id);
            return next;
          });
        };
        api
          .stopRun(run.id)
          .then((after) => {
            answered();
            showRun(task.id, after);
          })
          .catch((error: unknown) => {
            answered();
            if (!live.failed(error)) {
              const readOnly = readOnlyReason(error);
              say(
                readOnly !== undefined
                  ? t("run.stopReadOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) })
                  : refusedBy(error)
                    ? t("run.stopFailed")
                    : t("run.stopUnanswered"),
              );
            }
            loadRuns(task.id);
          });
      },
      // The star is a person's edit like any other (A5 3.11): shown at once, with a base, undoable.
      star: (task, on) => {
        edits.edit(task, starChange(on, latest.current.today));
      },
      // The view's move out of it (A5 3.5): through the one edit path, with its toast and undo.
      move: (task, kind) => {
        edits.edit(task, kind === "triage" ? triageChange() : statusChange("open"));
      },
      // Check-off, or during this tab's own hold, its undo (A5 3.12).
      check: (task) => {
        const entry = edits.getState().leaving.get(task.id);
        if (entry?.done === true) edits.uncheck(task.id);
        else edits.checkOff(task);
      },
      ask: (task, field) => {
        if (live.spaceId !== undefined) askFor(live.spaceId, task.id, field);
      },
      current: (task) => {
        setCurrent(task.id);
      },
    };
  }, [
    api,
    live,
    edits,
    expandTask,
    chosen,
    collapse,
    refuse,
    say,
    shown,
    showRun,
    loadBusy,
    loadRuns,
    t,
    list,
    toClipboard,
  ]);

  const onCurrent = useCallback((key: string) => {
    setCurrent(key);
  }, []);

  // The current row: the one chosen, or the first row when none is (or it left the view).
  let currentKey = current !== undefined && items.index.has(current) ? current : undefined;
  if (currentKey === undefined) currentKey = items.items.find((i) => i.kind === "row")?.key;

  const leavingOf = (id: string) => {
    const entry = holding.get(id);
    return keepsFinished && entry?.out === true ? undefined : entry;
  };

  const row = (item: RowItem, place: Place) => (
    <Row
      key={item.key}
      task={item.task}
      area={item.area}
      slot={item.slot}
      project={item.project}
      instances={state.instances}
      receipts={receipts.get(item.key) ?? NO_RECEIPTS}
      busy={busy.get(item.key)}
      runs={withStops(runs.get(item.key) ?? NO_RUNS, stops)}
      read={receipts.has(item.key) && runs.has(item.key)}
      runsFailed={runsFailed.has(item.key)}
      {...(unresolved?.id === item.key && expanded === item.key
        ? { unresolved: unresolved.failed ? "failed" : "reading" }
        : {})}
      ctx={item.finished && item.task.lifecycle !== "active" ? finishedCtx : ctx}
      expanded={expanded === item.key}
      current={place.current}
      fresh={fresh.has(item.key)}
      posinset={item.posinset}
      setsize={item.setsize}
      actions={actions}
      leaving={leavingOf(item.key)}
      refused={refusals.get(item.key)}
      muted={muted?.has(item.key) === true}
      beneath={beneath?.(item.task)}
      {...(place.index === undefined ? {} : { index: place.index })}
      {...(place.start === undefined ? {} : { start: place.start })}
      measure={place.measure}
    />
  );

  return (
    <>
      <List
        items={items}
        current={currentKey}
        expanded={expanded}
        onCurrent={onCurrent}
        onCollapse={collapse}
        row={row}
        // The empty line shows once the rows are live; the list keeps a row that holds focus.
        {...(state.phase === "live" && empty !== undefined
          ? { empty: <p className={styles.line}>{empty}</p> }
          : {})}
      />
      <div className={styles.announce} role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
