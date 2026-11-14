// A view's task list (A5 3.5, 3.6, 3.15): the view's open tasks from the live store, grouped by
// area and project (each view's own grouping is M5.04's and M5.05's), drawn by the one list
// (list/List.tsx) and the one row (row/Row.tsx). The rows are read from the store's state and never
// copied: the list derives its items from the published rows and keeps no rows of its own.
//
// What it holds itself: which task is expanded (one at a time) and which row is current, the launch
// receipts of the tasks this tab follows, the rows an agent has just added (they fade in), and the
// screen reader's summary of agents' changes in the view (A5 3.15 items 7 and 10).
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { requestId, type Instance, type Receipt } from "../api.ts";
import { useToast } from "../app/frame.ts";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { areaSlots, groupTasks, type Group } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { Latest } from "../latest.ts";
import { itemsOf, type RowItem } from "../list/items.ts";
import { List, type Place } from "../list/List.tsx";
import { contextFor, type Grouping, type RowView } from "../row/model.ts";
import type { RowActions } from "../row/actions.ts";
import type { Clock } from "../row/dates.ts";
import { Row } from "../row/Row.tsx";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { rowOfFacts } from "../task/detail.ts";
import css from "./TaskList.module.css";

const styles = classes(css, ["line", "announce"]);

const NO_RECEIPTS: readonly Receipt[] = [];
/** How long a row an agent added keeps its accent (A5 3.20: 1.2 s). */
const FRESH_MS = 1_200;
/** Agents' changes are announced once the burst has been quiet this long (A5 3.15 item 10). */
const QUIET_MS = 2_000;

/** The expanded task as the list last showed it: its group and its place in that group's list. */
export interface HeldRow {
  readonly task: TaskRow;
  readonly group?: string;
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
  /** The view's own groups (Today's sections). */
  readonly groups?: GroupsOf;
  /** The view's clock, when the view reads it too (Today's sections and strip). */
  readonly clock?: Clock;
  /** The line an empty view shows. */
  readonly empty: string;
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
}

export function TaskList({
  view,
  grouping = "area",
  filter,
  groups: groupsOf,
  clock: viewClock,
  empty,
  expand: wantedRef,
  onExpand,
}: TaskListProps) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const state = useLive();
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [receipts, setReceipts] = useState<ReadonlyMap<string, readonly Receipt[]>>(new Map());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  /** The URL's task, read with `task.get` because the live rows do not hold it. */
  const [injected, setInjected] = useState<TaskRow | undefined>(undefined);
  /** The tasks whose receipts the tab follows: the expanded one, and every one it launched. */
  const watched = useRef(new Set<string>());
  const receiptReads = useRef(new Latest());
  const changed = useRef(onExpand);
  changed.current = onExpand;
  /** The expanded task's row as last seen: it stays while expanded, whatever the update did. */
  const held = useRef<TaskRow | undefined>(undefined);
  /** What the callbacks read: one object for every row, for good. */
  const latest = useRef<{ expanded: string | undefined; today: string }>({
    expanded: undefined,
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

  // The expanded task's newest row: live, else the injected one, else the last one seen.
  const expandedRow =
    expanded === undefined
      ? undefined
      : (state.tasks.get(expanded) ??
        (injected?.id === expanded ? injected : undefined) ??
        (held.current?.id === expanded ? held.current : undefined));
  held.current = expandedRow;

  /** Where the expanded row was shown last: its group and its place there. */
  const place = useRef<{ id: string; group: string; index: number } | undefined>(undefined);

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
              ...(was?.id === expandedRow.id ? { group: was.group, index: was.index } : {}),
            };
      groups = groupsOf(state.tasks, held);
    } else {
      const tasks = [...state.tasks.values()].filter(filter);
      if (expandedRow !== undefined && !tasks.some((task) => task.id === expandedRow.id)) {
        tasks.push(expandedRow);
      }
      groups = groupTasks(tasks, state.areas.values(), state.projects.values());
    }
    return itemsOf(groups, state.areas, state.projects, areaSlots(state.areas.values()));
  }, [state.tasks, state.areas, state.projects, filter, groupsOf, expandedRow]);

  // Where the expanded row is now, for the next update (a view's own groups keep it there).
  const shownAt = expanded === undefined ? undefined : items.index.get(expanded);
  const shownItem = shownAt === undefined ? undefined : items.items[shownAt];
  place.current =
    shownItem?.kind === "row"
      ? { id: shownItem.key, group: shownItem.group, index: shownItem.posinset - 1 }
      : expanded === undefined
        ? undefined
        : place.current;

  const timed = useMemo(
    () => items.items.some((item) => item.kind === "row" && item.task.due_at !== undefined),
    [items],
  );
  const ownClock = useClock(timed && viewClock === undefined);
  const clock = viewClock ?? ownClock;
  // The other views' rows sit under area headings until M5.05 gives each its grouping.
  const ctx = useMemo(() => contextFor(view, grouping, clock), [view, grouping, clock]);

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
        });
    },
    [api, live],
  );

  // A launch event refreshes the receipts of its task, which the tab follows from then on, so a
  // tile mirrors a launch made in another tab or at the terminal. A fresh snapshot refreshes all.
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        const named = new Set<string>(reset ? watched.current : []);
        for (const change of changes) {
          if (change.type !== "launch") continue;
          // A launch the feed does not tie to a task refreshes every task the tab follows.
          if (change.task === undefined) for (const task of watched.current) named.add(task);
          else named.add(change.task);
        }
        for (const task of named) {
          watched.current.add(task);
          loadReceipts(task);
        }
      }),
    [live, loadReceipts],
  );

  // Rows an agent adds fade in; agents' changes to the view's tasks are announced once the burst
  // settles, by actor ("3 tasks updated by Codex").
  const inView = useRef(filter);
  inView.current = filter;
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
      // An injected row belongs to its expansion: another task's expansion ends it.
      setInjected((known) => (known?.id === task.id ? known : undefined));
      watched.current.add(task.id);
      loadReceipts(task.id);
    },
    [loadReceipts],
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

  // The URL's task (a link, `tasks open <task>`, a reload, Back and Forward) expands once it is
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

  /** Puts a brief on the clipboard, in the person's click (A4 3.4.6). */
  const toClipboard = useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          say(t("row.copied"));
        })
        .catch(() => {
          say(t("row.copyFailed"));
        });
    },
    [say, t],
  );

  // The row actions read the latest state through a ref: one object for every row, for good.
  latest.current = { expanded, today: clock.today };
  const actions = useMemo<RowActions>(() => {
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
      // A tile whose launch is on its way or done (A5 3.6): the row expands, and stays expanded.
      expand: (task) => {
        if (latest.current.expanded !== task.id) {
          chosen(task.ref);
          expandTask(task);
          changed.current?.(task);
        }
      },
      // Open (A4's `launch.open`). An app that takes the brief by paste (Codex's assisted open)
      // gets it on the clipboard too.
      open: (task: TaskRow, instance: Instance) => {
        watched.current.add(task.id);
        api
          .openLaunch(task.id, instance.key, requestId())
          .then(({ receipt, copy }) => {
            shown(task, receipt);
            if (copy !== undefined) toClipboard(copy);
          })
          .catch((error: unknown) => {
            if (!live.failed(error)) say(t("row.openFailed"));
          });
      },
      // Copy (A4 3.4.6): the pointer brief, as a launch of its own whose reference an agent redeems.
      copy: (task) => {
        watched.current.add(task.id);
        api
          .openLaunch(task.id, undefined, requestId())
          .then(({ receipt, copy: text }) => {
            shown(task, receipt);
            if (text !== undefined) toClipboard(text);
          })
          .catch((error: unknown) => {
            if (!live.failed(error)) say(t("row.copyFailed"));
          });
      },
      // The star shows at once and holds until the feed confirms it (A5 3.15's overlay).
      star: (task, on) => {
        const overlay = on
          ? { tasks: [{ id: task.id, set: { focus_on: latest.current.today } }] }
          : { tasks: [{ id: task.id, set: {}, clear: ["focus_on" as const] }] };
        live
          .write(
            (request) =>
              api.client.task.update(
                // The base is what the row showed: a star changed since then is a conflict.
                {
                  task: task.id,
                  ...(on ? { set: { focus: true } } : { clear: ["focus" as const] }),
                  ...(live.store.asOf === undefined ? {} : { base: live.store.asOf }),
                  request_id: request,
                },
              ),
            overlay,
          )
          .answer.catch((error: unknown) => {
            if (!live.failed(error)) say(t("row.starFailed"));
          });
      },
      // The title, edited in place (A5 3.7): shown at once, held until the feed confirms it.
      rename: (task) => {
        // The base is taken when the editor opens: what the person saw when they began to type.
        const base = live.store.asOf;
        return (title) => {
          live
            .write(
              (request) =>
                api.client.task.update({
                  task: task.id,
                  set: { title },
                  ...(base === undefined ? {} : { base }),
                  request_id: request,
                }),
              { tasks: [{ id: task.id, set: { title } }] },
            )
            .answer.catch((error: unknown) => {
              if (!live.failed(error)) say(t("task.renameFailed"));
            });
        };
      },
      current: (task) => {
        setCurrent(task.id);
      },
    };
  }, [api, live, expandTask, chosen, collapse, say, shown, t, toClipboard]);

  const onCurrent = useCallback((key: string) => {
    setCurrent(key);
  }, []);

  // The current row: the one chosen, or the first row when none is (or it left the view).
  let currentKey = current !== undefined && items.index.has(current) ? current : undefined;
  if (currentKey === undefined) currentKey = items.items.find((i) => i.kind === "row")?.key;

  const row = (item: RowItem, place: Place) => (
    <Row
      key={item.key}
      task={item.task}
      area={item.area}
      slot={item.slot}
      project={item.project}
      instances={state.instances}
      receipts={receipts.get(item.key) ?? NO_RECEIPTS}
      ctx={ctx}
      expanded={expanded === item.key}
      current={place.current}
      fresh={fresh.has(item.key)}
      posinset={item.posinset}
      setsize={item.setsize}
      actions={actions}
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
        {...(state.phase === "live" ? { empty: <p className={styles.line}>{empty}</p> } : {})}
      />
      <div className={styles.announce} role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
