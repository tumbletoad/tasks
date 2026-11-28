// The task row: the model from `renderRow` drawn in fixed columns. The title is a
// button that expands the row in place; the checkbox, the sources, the folder, the star and the
// launch tile are its siblings, never its children, and never expand it by themselves. A click
// anywhere else in the title's column, empty space included, expands it as the title does. A roving
// tabindex puts only the current row in the tab order: its title first, then its other controls.
//
// The row is memoised: it renders again only when its own task, its area or project, its receipts,
// what busies its agent apps, its place in the list or its state (expanded, current, fresh) changes. Every prop it takes is a
// value the list keeps by identity, so a store update that touches one task renders one row.
import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { Instance, LastUsed } from "@ttasks/contracts/runs";
import type { Receipt, Run } from "../api.ts";
import { Session } from "../context.ts";
import { titleChange } from "../edit/change.ts";
import { whoOf, type Leaving } from "../edit/edits.ts";
import { KeptActions } from "../edit/KeptActions.tsx";
import { Unsaved } from "../edit/Unsaved.tsx";
import { useEdits } from "../edit/useEdits.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { is } from "../keys/keymap.ts";
import { useIntl } from "react-intl";
import type { NodeRow, TaskRow } from "@ttasks/client/store";
import { Expanded } from "../task/Expanded.tsx";
import { NotSaved, Pen, TextEditor, useEditing, useSaved } from "../task/TextEditor.tsx";
import { useTextWrites } from "../task/textWrites.ts";
import { agentMarker } from "../task/runs.ts";
import { placeFact, sourceFacts } from "../task/sources.ts";
import { classes } from "../app/css.ts";
import { readOnly, type RowActions } from "./actions.ts";
import { tileClick, type BusyOf, type Cannot, type FolderRefusal } from "./launch.ts";
import { formatInstant } from "@ttasks/client/today";
import { renderRow, type RowContext, type RowModel } from "./model.ts";
import { sayMsg } from "./say.ts";
import { KeptTitles } from "./KeptTitles.tsx";
import {
  keepTitleDraft,
  letGo,
  pageLeaving,
  readTitleDraft,
  SUMMARY_MAX,
  TITLE_MAX,
  type TitleDraft,
  useHasDraft,
} from "../unsent.ts";
import {
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  FolderElsewhereIcon,
  PencilIcon,
  FolderIcon,
  PersonIcon,
  SourceIcon,
  StarIcon,
} from "./icons.tsx";
import css from "./Row.module.css";

const styles = classes(css, [
  "row",
  "line",
  "beneath",
  "marker",
  "check",
  "box",
  "main",
  "tline",
  "title",
  "chip",
  "summary",
  "prefix",
  "dot",
  "text",
  "slots",
  "due",
  "age",
  "prio",
  "effort",
  "sources",
  "source",
  "more",
  "slot",
  "folder",
  "launch",
  "icon",
  "tile",
  "body",
  "unresolved",
  "edit",
  "remote",
  "move",
]);

const NO_LAST: LastUsed = {};
const NO_CANNOT: Cannot = new Map();

export interface RowProps {
  readonly task: TaskRow;
  readonly area: NodeRow | undefined;
  readonly slot: number | undefined;
  readonly project: NodeRow | undefined;
  readonly instances: readonly Instance[];
  /** The instances the space last opened a task in and ran one with here. */
  readonly last?: LastUsed;
  /** Why an instance refused its last Open here, by key: its code, until one goes through. */
  readonly cannot?: Cannot;
  /** The task's launch receipts, oldest first, once the tab follows the task: its history. */
  readonly receipts: readonly Receipt[];
  /** What busies each agent app with the task on this machine. */
  readonly busy: BusyOf | undefined;
  /** The task's background runs, oldest first, once the tab follows the task. */
  readonly runs: readonly Run[];
  /** Whether the task's receipts and runs were read: until then its card's thread waits. */
  readonly read?: boolean;
  /** The last read of its runs failed: the thread says so until a read goes through. */
  readonly runsFailed?: boolean;
  /**
   * How the task is now is not known (a fresh snapshot left it out): it is being read again, or
   * that read failed. The row shows what it last knew and offers nothing that changes the task.
   */
  readonly unresolved?: "reading" | "failed";
  readonly ctx: RowContext;
  readonly expanded: boolean;
  /** The row in the tab order (the roving tabindex). */
  readonly current: boolean;
  /** An agent just added it: it fades in. */
  readonly fresh: boolean;
  readonly posinset: number;
  readonly setsize: number;
  readonly actions: RowActions;
  /** Checked off and in its hold, or completed by someone else and leaving. */
  readonly leaving?: Leaving | undefined;
  /** Its last Open, refused on its folder: the expanded task says so at once. */
  readonly refused?: FolderRefusal | undefined;
  /** Its place in the view comes from what an agent did when the page last heard: shown muted. */
  readonly muted?: boolean;
  /** What the view shows beneath the row's line, such as the agents that work on the task. */
  readonly beneath?: ReactNode;
  /** In a virtual list: the item's index and its offset from the list's top, in px. */
  readonly index?: number;
  readonly start?: number;
  readonly measure?: ((element: HTMLElement | null) => void) | undefined;
}

/** A source opens in a new tab with no opener and no referrer. */
const LINK_REL = ["noopener", "noreferrer"].join(" ");

function Slots({
  model,
  task,
  tab,
  expanded,
  still,
  actions,
  t,
}: {
  readonly model: RowModel;
  readonly task: TaskRow;
  readonly tab: number;
  readonly expanded: boolean;
  /** The row offers nothing that changes the task, nor a launch. */
  readonly still: boolean;
  readonly actions: RowActions;
  readonly t: Translate;
}) {
  const say = (m: Parameters<typeof sayMsg>[1]) => sayMsg(t, m);
  const { launch, folder } = model;
  const tileTip = say(launch.tip);
  return (
    <div className={styles.slots}>
      <span
        className={styles.due}
        data-part="row-due"
        data-tone={model.due?.tone}
        data-tip={model.due === undefined ? undefined : say(model.due.tip)}
      >
        {model.due?.tone === "late" ? <ClockIcon /> : null}
        {model.due === undefined ? null : say(model.due.text)}
      </span>
      <span
        className={styles.age}
        data-tip={model.age === undefined ? undefined : say(model.age.tip)}
      >
        {model.age === undefined ? null : say(model.age.text)}
      </span>
      <span className={styles.prio} data-level={model.priority?.level}>
        {model.priority === undefined ? null : say(model.priority.text)}
      </span>
      {/* Focusable, so the keyboard brings up what the level means as the mouse does. */}
      <span
        className={styles.effort}
        data-part="row-effort"
        {...(model.effort === undefined
          ? {}
          : {
              "data-tip": say(model.effort.tip),
              "aria-description": say(model.effort.tip),
              tabIndex: tab,
            })}
      >
        {model.effort?.key}
      </span>
      <span className={styles.sources}>
        {model.sources.shown.map((source, i) => {
          const tip = say(source.tip);
          return source.href === undefined ? (
            <span key={i} className={styles.source} role="img" aria-label={tip} data-tip={tip}>
              <SourceIcon kind={source.kind} />
            </span>
          ) : (
            <a
              key={i}
              className={styles.source}
              href={source.href}
              target="_blank"
              rel={LINK_REL}
              aria-label={tip}
              data-tip={tip}
              tabIndex={tab}
            >
              <SourceIcon kind={source.kind} />
            </a>
          );
        })}
        {model.sources.more === undefined ? null : (
          <span className={styles.more}>{say(model.sources.more)}</span>
        )}
      </span>
      <span className={`${styles.slot} ${styles.folder}`}>
        {folder.state === "empty" ? null : (
          <button
            type="button"
            className={styles.icon}
            data-part="folder"
            data-state={folder.state}
            aria-label={folder.tip === undefined ? undefined : say(folder.tip)}
            // A folder not found is looked for again: a drive may have come back since.
            aria-disabled={folder.state === "elsewhere"}
            data-tip={folder.tip === undefined ? undefined : say(folder.tip)}
            tabIndex={tab}
            onClick={() => {
              if (folder.state !== "elsewhere") actions.folder(task);
            }}
          >
            {folder.state === "elsewhere" ? <FolderElsewhereIcon /> : <FolderIcon />}
          </button>
        )}
      </span>
      <span className={styles.slot}>
        <button
          type="button"
          className={styles.icon}
          data-part="star"
          data-on={model.starred}
          aria-label={t("row.star")}
          aria-pressed={model.starred}
          // A finished task takes no edit, nor one in the Trash: its star would only be
          // refused.
          aria-disabled={still || task.lifecycle !== "active" || undefined}
          data-tip={t("row.star")}
          tabIndex={tab}
          onClick={() => {
            if (!still && task.lifecycle === "active") actions.star(task, !model.starred);
          }}
        >
          <StarIcon />
        </button>
      </span>
      {/* Expanded, the launch slot holds the collapse button: the body owns the launch. */}
      {expanded ? (
        <span className={styles.slot}>
          <button
            type="button"
            className={styles.icon}
            data-part="collapse"
            aria-label={t("task.collapse")}
            data-tip={t("task.collapse")}
            tabIndex={tab}
            onClick={(event) => {
              // The button leaves with the card: focus goes to the title first, as Escape's does.
              event.currentTarget
                .closest("[data-row-line]")
                ?.querySelector<HTMLElement>('[data-part="title"]')
                ?.focus({ preventScroll: true });
              actions.toggle(task);
            }}
          >
            <ChevronUpIcon />
          </button>
        </span>
      ) : null}
      <span className={`${styles.slot} ${styles.launch}`}>
        {launch.state === "none" || still ? null : (
          <button
            type="button"
            className={styles.tile}
            data-part="tile"
            data-state={launch.state}
            data-ring={launch.instance?.ring}
            data-instance={launch.instance?.key}
            aria-label={
              launch.instance === undefined
                ? tileTip
                : t("row.openIn", { label: launch.instance.label })
            }
            aria-disabled={launch.state === "elsewhere" || launch.state === "opening"}
            data-tip={tileTip}
            tabIndex={tab}
            onClick={(event) => {
              // A double click is one click, even when the first one's answer came in between.
              if (event.detail > 1) return;
              const action = tileClick(launch.state);
              if (action === "open" && launch.instance !== undefined)
                void actions.open(task, launch.instance);
              else if (action === "expand") actions.expand(task);
              else if (action === "copy") void actions.copy(task, event.shiftKey);
            }}
          >
            {launch.state === "copy_only" ? <CopyIcon /> : launch.instance?.glyph}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The title's editor: Enter or leaving the field saves a changed title, Escape keeps
 * the old one. Enter and Escape put focus back on the title, so the keyboard stays on the row;
 * leaving for another control keeps focus there. The save
 * is the person's edit like any other (edits.ts), with the base taken when the editor opened: a
 * title someone else changed while the person typed is a conflict, never overwritten, and the
 * field says so while the person types. Leaving the window is not leaving the field: the editor
 * stays open with what was typed. What is typed is kept in the browser (unsent.ts) until the service
 * has answered its save: after a reload the editor opens with it again, and a refusal keeps it as a
 * refused edit is kept. Only the person's Enter or leaving the field saves it.
 */
function TitleEditor({
  task,
  label,
  brought,
  onDone,
}: {
  readonly task: TaskRow;
  readonly label: string;
  /** The kept words the card opened this editor for, as the card read them. */
  readonly brought: TitleDraft | undefined;
  readonly onDone: () => void;
}) {
  const t = useT();
  const edits = useEdits();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Taken once, as the editor opens: the save's base is the title the person began to change, also
  // when a reload brought back what they typed.
  const [opened] = useState(() => {
    // The words the card opened this editor for are brought back whatever the title became since
    // the card read them, as long as they are still the kept ones: what the person typed or
    // discarded since is what counts. Other kept words that already show as the title are a save
    // on its way: the editor starts from the title.
    const found = readTitleDraft(space, task.id);
    const cards = brought !== undefined && found?.typed === brought.typed;
    const kept = !cards && found?.typed.trim() === task.title ? undefined : found;
    return {
      base: kept === undefined ? edits.seen(task, ["title"]) : kept.base,
      mark: edits.mark(),
      title: kept?.title ?? task.title,
      typed: kept?.typed,
    };
  });
  const before = opened.title;
  // Words a reload brought back whose save was still on its way: when the title arrives as them,
  // and the person has not typed since, they are saved, and the editor that held them closes.
  useEffect(() => {
    const words = opened.typed;
    if (words === undefined || done.current || task.title !== words.trim()) return;
    if (field.current?.value !== words) return;
    done.current = true;
    letGo(space, { kind: "title", task: task.id, text: words });
    onDone();
  }, [task.title, task.id, opened, space, onDone]);
  /** What the person typed, for a save when the editor goes away under them. */
  const typed = useRef<string | undefined>(undefined);
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    const input = field.current;
    input?.focus();
    // What a reload brought back goes on from its end.
    if (opened.typed === undefined) input?.select();
    else input?.setSelectionRange(input.value.length, input.value.length);
  }, [opened]);
  /** Sends what was typed; the kept words go once the service holds them or the edit keeps them. */
  const save = (row: TaskRow, value: string) => {
    edits.edit(row, titleChange(value.trim()), {
      ...(opened.base === undefined ? {} : { base: opened.base }),
      settled: () => {
        letGo(space, { kind: "title", task: row.id, text: value });
      },
    });
  };
  // The feed says the task was moved to the Trash, or its creation undone: it takes no title.
  const removed = useRef(false);
  useEffect(
    () =>
      live.onChanges(({ changes }) => {
        for (const change of changes) {
          const after = change.after as TaskRow | undefined;
          if (change.type === "task" && change.id === task.id && after?.deleted_at !== undefined) {
            removed.current = true;
          }
        }
      }),
    [live, task.id],
  );
  // The row goes away while the person types (the task leaves the view, the card collapses): what
  // they typed is saved, as leaving the field does, never dropped. A task moved to the Trash takes
  // no title: the words stay kept, unsent, for its card there and its return.
  useEffect(
    () => () => {
      const value = typed.current ?? "";
      const title = value.trim();
      if (done.current || title === "" || title === before) return;
      done.current = true;
      if (removed.current) return;
      save(latest.current, value);
    },
    // The editor's own values, fixed while it is open.
    [edits, before, opened, space],
  );
  /** `refocus`: Enter or Escape put focus back on the title; leaving the field keeps its target. */
  const finish = (keep: boolean, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = field.current?.value ?? "";
    const title = value.trim();
    const sending = keep && title !== "" && title !== before;
    // Escape, or nothing to save: what this editor typed or brought back waits no more. Words it
    // never touched are an earlier save's, still on its way: they stay until that save is answered.
    const own = typed.current !== undefined || opened.typed !== undefined;
    if (!sending && own) keepTitleDraft(space, task.id, undefined);
    const line = field.current?.closest("[data-row-line]");
    // The title is drawn back before focus goes to it, within this key: a key pressed right after
    // acts from the title, and nothing moves focus later.
    if (refocus) flushSync(onDone);
    else onDone();
    if (sending) save(task, value);
    if (refocus) {
      line?.querySelector<HTMLElement>('[data-part="title"]')?.focus({ preventScroll: true });
    }
  };
  // Someone else changed the title while the person types: the typed text stays.
  const remote =
    task.title === before ? undefined : edits.changedSince(task.id, "title", opened.mark);
  return (
    <span className={styles.edit} data-part="title-editor">
      <input
        ref={field}
        data-part="title-edit"
        aria-label={label}
        defaultValue={opened.typed ?? before}
        maxLength={TITLE_MAX}
        dir="auto"
        onInput={(event) => {
          const value = event.currentTarget.value;
          typed.current = value;
          keepTitleDraft(
            space,
            task.id,
            value === before
              ? undefined
              : {
                  typed: value,
                  title: before,
                  ...(opened.base === undefined ? {} : { base: opened.base }),
                },
          );
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true, true);
          } else if (event.key === "Escape") {
            // Escape leaves the editor only: the list must not collapse the row.
            event.preventDefault();
            event.stopPropagation();
            finish(false, true);
          }
        }}
        onBlur={(event) => {
          // The window lost focus (another app, another tab) or the page goes away: the field
          // keeps what was typed for its return.
          if (!document.hasFocus() || pageLeaving()) return;
          // Focus went to another control: it stays there. Nowhere: back to the title.
          finish(true, event.relatedTarget === null);
        }}
      />
      {task.title === before ? null : (
        <span className={styles.remote} data-part="remote" role="status">
          {t("edit.changedBy", whoOf(remote?.by ?? ""))}
        </span>
      )}
    </span>
  );
}
/**
 * After a check-off or a dismissed question, focus moves to the next row, or else the previous
 * one, or else the view: never to a row that is itself leaving. A row that holds focus
 * stays where it is, so the row the person acted on is free to move.
 */
export function focusAfter(from: HTMLElement): void {
  const list = from.closest("[data-list]");
  const own = from.closest("li")?.querySelector<HTMLElement>('[data-part="title"]');
  const titles = [...(list?.querySelectorAll<HTMLElement>('[data-part="title"]') ?? [])];
  const at = own === null || own === undefined ? -1 : titles.indexOf(own);
  const open = (e: HTMLElement) => e.closest('li[data-done="true"]') === null;
  const next =
    titles.slice(at + 1).find(open) ?? titles.slice(0, Math.max(at, 0)).reverse().find(open);
  (next ?? document.getElementById("main"))?.focus({ preventScroll: true });
}

function RowView({
  task,
  area,
  slot,
  project,
  instances,
  last = NO_LAST,
  cannot = NO_CANNOT,
  receipts,
  busy,
  runs,
  read = true,
  runsFailed = false,
  unresolved,
  ctx,
  expanded,
  current,
  fresh,
  posinset,
  setsize,
  actions: given,
  leaving,
  refused,
  muted = false,
  beneath,
  index,
  start,
  measure,
}: RowProps) {
  const t = useT();
  const intl = useIntl();
  // A task in the Trash is for reading until it is restored, and one whose state is not known
  // until it is read again: its row gets only the actions that read (actions.ts).
  const trashed = task.deleted_at !== undefined;
  const still = trashed || unresolved !== undefined;
  const actions = still ? readOnly(given) : given;
  const place = placeFact(task.place);
  const marker = agentMarker(task.run, instances, task.questions?.[0]);
  const { live } = useContext(Session);
  const draft = useHasDraft(live.spaceId ?? "", task.id);
  const model = renderRow(
    {
      task,
      ...(marker === undefined ? {} : { marker }),
      ...(area === undefined ? {} : { area: { title: area.title, slot: slot ?? 1 } }),
      ...(project === undefined ? {} : { project: { title: project.title } }),
      instances,
      last,
      ...(busy === undefined ? {} : { busy }),
      sources: sourceFacts(t, task.sources),
      ...(task.sources_more === undefined ? {} : { sourcesMore: task.sources_more }),
      ...(place === undefined ? {} : { place }),
      ...(task.waiting_since === undefined ? {} : { waitingSince: task.waiting_since }),
      ...(draft ? { draft } : {}),
    },
    ctx,
  );
  // A finished task's line says how it ended; an open task, and one without an ending, the summary.
  const line = model.ending ?? model.summary;
  const tab = current ? 0 : -1;
  // Checked: completed, or checked off and in its hold. The box takes a check-off of an open task,
  // and during this tab's own hold, its undo.
  const active = task.lifecycle === "active";
  const checked = leaving === undefined ? !active : leaving.done;
  const checkable = !still && (leaving === undefined ? active : leaving.by === undefined);
  const completedTip =
    leaving?.by === undefined
      ? undefined
      : t("row.completedBy", {
          ...whoOf(leaving.by),
          time: formatInstant(leaving.at ?? 0, ctx.clock, { timeStyle: "short" }),
        });
  const body = `row-${task.id}-body`;
  const described = `row-${task.id}-desc`;
  const toggle = () => {
    actions.toggle(task);
  };
  // The title edits in place, for typo fixes: only an open task's, the one kind the
  // service changes. Editing expands the row, so the card is what is being edited. The card opens
  // it for kept words with those words, so the editor works from what the card read.
  const [editing, setEditing] = useState<false | { readonly brought?: TitleDraft }>(false);
  // In the Trash the title is read, never edited: a kept one waits there with Copy and Discard.
  const editable = active && !still;
  // The summary is corrected in place behind its pen, as the context is, once the card is open.
  const summary = task.summary ?? "";
  const [summing, setSumming] = useEditing(
    live.spaceId ?? "",
    task.id,
    "summary",
    summary,
    editable && expanded && summary !== "",
  );
  const [summed, setSummed] = useSaved(summary);
  const text = summary === "" || model.ending !== undefined ? line : summed;
  const writes = useTextWrites();
  // The row the person moved out of the view: while focus holds it there with the data it
  // had, its move is done, so the button goes. Newer data (an undo) brings it back.
  const [movedFrom, setMovedFrom] = useState<TaskRow | undefined>(undefined);
  const edit = () => {
    if (!editable) return;
    if (!expanded) actions.expand(task);
    setEditing({});
  };
  // A title the person was typing when the page went away comes back in its editor with the card,
  // unless the title shows it: the service took it before the page went, or this tab's save of it is
  // on its way and that save's answer lets the words go.
  const space = live.spaceId ?? "";
  const edits = useEdits();
  useEffect(() => {
    const kept = readTitleDraft(space, task.id);
    if (!expanded || kept === undefined) return;
    if (kept.typed.trim() !== task.title) {
      if (editable) setEditing({ brought: kept });
    } else if (!edits.sending(task.id)) {
      letGo(space, { kind: "title", task: task.id, text: kept.typed });
    }
    // The title is read as the card opens, not again as it changes.
  }, [expanded, space, task.id, editable, edits]);
  // The offset is a custom property set through the CSSOM (React's style object), which the CSP's
  // style-src allows; the stylesheet turns it into a transform. Nothing writes a style attribute.
  const position =
    start === undefined ? undefined : ({ "--k-y": `${String(start)}px` } as CSSProperties);
  return (
    <li
      ref={measure}
      className={styles.row}
      style={position}
      data-index={index}
      data-key={task.id}
      data-task={task.ref}
      data-expanded={expanded}
      data-current={current}
      data-fresh={fresh || undefined}
      data-done={leaving?.done === true || undefined}
      data-muted={muted || undefined}
      data-leaving={leaving === undefined ? undefined : leaving.out ? "out" : "hold"}
      aria-posinset={posinset}
      aria-setsize={setsize}
      onFocus={() => {
        if (!current) actions.current(task);
      }}
    >
      <div className={styles.line} data-row-line="">
        <span className={styles.marker} data-kind={model.marker?.kind}>
          {model.marker === undefined ? null : (
            <span
              role="img"
              aria-label={sayMsg(t, model.marker.tip)}
              data-tip={sayMsg(t, model.marker.tip)}
            >
              {model.marker.kind === "draft" ? <PencilIcon /> : null}
            </span>
          )}
        </span>
        <span className={styles.check} data-tip={completedTip}>
          {/* Check-off is final at once (D12): the row holds, the toast offers Undo. A task
              in the Trash has no box: Restore is its one action. */}
          {trashed ? null : (
            <input
              type="checkbox"
              className={styles.box}
              data-part="check"
              data-dropped={(leaving === undefined && task.lifecycle === "archived") || undefined}
              aria-label={sayMsg(t, model.done)}
              checked={checked}
              disabled={!checkable}
              tabIndex={tab}
              onChange={(event) => {
                // Focus moves on at once, so the row that stays for its hold is not in the way.
                if (!checked) focusAfter(event.currentTarget);
                actions.check(task);
              }}
            />
          )}
        </span>
        <div
          className={styles.main}
          onClick={(event) => {
            // A control in the column does only its own thing, and a click that ends a selection
            // of the text selects it. Expanded, the title collapses the card and the summary asks.
            if (expanded || (event.target as Element).closest("button, a, input") !== null) return;
            if (!(window.getSelection()?.isCollapsed ?? true)) return;
            // The row becomes current, as if its title had been clicked.
            event.currentTarget
              .querySelector<HTMLElement>('[data-part="title"]')
              ?.focus({ preventScroll: true });
            toggle();
          }}
        >
          <div className={styles.tline}>
            {editing !== false && editable ? (
              <TitleEditor
                task={task}
                label={t("task.title")}
                brought={editing.brought}
                onDone={() => {
                  setEditing(false);
                }}
              />
            ) : (
              <button
                type="button"
                className={styles.title}
                data-part="title"
                aria-expanded={expanded}
                aria-controls={expanded ? body : undefined}
                aria-describedby={described}
                tabIndex={tab}
                onClick={(event) => {
                  // The second click of a double-click is the editor's, not another toggle.
                  if (event.detail < 2) toggle();
                }}
                onDoubleClick={edit}
                onKeyDown={(event) => {
                  if (is(event.nativeEvent, "rename")) {
                    event.preventDefault();
                    edit();
                  } else if (is(event.nativeEvent, "trash")) {
                    event.preventDefault();
                    // A held key moves one task: its repeats reach the next row's title.
                    if (event.repeat || still) return;
                    focusAfter(event.currentTarget);
                    edits.trash(task);
                  }
                }}
              >
                <span dir="auto">{model.title}</span>
              </button>
            )}
            {model.chip === undefined ? null : (
              <span className={styles.chip} data-kind={model.chip.kind}>
                {model.chip.person ? <PersonIcon /> : null}
                <span dir="auto">{sayMsg(t, model.chip.text)}</span>
              </span>
            )}
            {model.move === undefined || expanded || movedFrom === task ? null : (
              // The view's move out of it, visible on the row; expanded, the facts own it.
              <button
                type="button"
                className={styles.move}
                data-part="move"
                data-move={model.move.kind}
                tabIndex={tab}
                onClick={(event) => {
                  // Focus goes to the title first: the row then stays where it is, with its new
                  // data, until focus leaves it, and the button that goes with
                  // the move takes no focus with it.
                  event.currentTarget
                    .closest("[data-row-line]")
                    ?.querySelector<HTMLElement>('[data-part="title"]')
                    ?.focus({ preventScroll: true });
                  if (model.move === undefined) return;
                  setMovedFrom(task);
                  actions.move(task, model.move.kind);
                }}
              >
                {sayMsg(t, model.move.text)}
              </button>
            )}
          </div>
          {summing ? (
            <TextEditor
              space={space}
              owner={task.id}
              part="summary"
              label={t("task.summary")}
              text={summary}
              line
              max={SUMMARY_MAX}
              base={edits.seen(task, ["summary"])}
              save={(words, base) => writes.summary(task, words, base)}
              onDone={(words) => {
                setSummed(words);
                setSumming(false);
              }}
            />
          ) : model.prefix === undefined && line === undefined ? null : (
            <div
              className={styles.summary}
              data-part={model.ending === undefined ? "summary" : "ending"}
              data-tip={expanded && !trashed ? t("ask.tip") : undefined}
              onClick={(event) => {
                // Expanded, the line is an agent's to change: a click asks one, unless
                // it ends a selection of its text or was on its pen.
                if (!expanded || !(window.getSelection()?.isCollapsed ?? true)) return;
                if ((event.target as Element).closest("button") !== null) return;
                actions.ask(task, model.ending === undefined ? "summary" : "outcome");
              }}
            >
              {model.prefix === undefined ? null : (
                <span className={styles.prefix}>
                  {model.prefix.slot === undefined ? null : (
                    <span
                      className={`${styles.dot} slot-${String(model.prefix.slot)}`}
                      aria-hidden="true"
                    />
                  )}
                  <span dir="auto">{model.prefix.text}</span>
                </span>
              )}
              {text === undefined ? null : (
                <span className={styles.text} dir="auto">
                  {text}
                </span>
              )}
              {expanded && editable && model.ending === undefined && summary !== "" ? (
                <Pen
                  label={t("text.editSummary")}
                  onPress={() => {
                    setSumming(true);
                  }}
                />
              ) : null}
            </div>
          )}
          {expanded && editable ? <NotSaved space={space} owner={task.id} part="summary" /> : null}
          {/* A title the person typed while the task was finished stays readable, with Copy and
              Discard; Try again only once the task is active again. */}
          {expanded ? (
            <Unsaved task={task.id} field="title" finished={!active} trashed={trashed} />
          ) : null}
          {/* A check-off, an undo or the like that a page did not get to send before it went. */}
          {expanded ? <KeptActions task={task} /> : null}
          {/* What another tab is typing, or what was typed before the task was finished. */}
          {expanded ? (
            <KeptTitles
              space={space}
              task={task.id}
              finished={!active || trashed}
              trashed={trashed}
            />
          ) : null}
        </div>
        <Slots
          model={model}
          task={task}
          tab={tab}
          expanded={expanded}
          still={still}
          actions={actions}
          t={t}
        />
        <span id={described} hidden>
          {intl.formatList(
            model.description.map((m) => sayMsg(t, m)),
            { type: "unit", style: "short" },
          )}
        </span>
      </div>
      {beneath === undefined ? null : <div className={styles.beneath}>{beneath}</div>}
      {expanded ? (
        <div className={styles.body} id={body} role="region" aria-label={task.title}>
          {unresolved === undefined ? null : (
            <p className={styles.unresolved} role="status" data-part="unresolved">
              {t(unresolved === "reading" ? "task.rereading" : "task.rereadFailed")}
            </p>
          )}
          {/* Kept while hidden: what the person typed and the thread read stay for when it is
              known again. */}
          <Expanded
            task={task}
            receipts={receipts}
            busy={busy}
            runs={runs}
            read={read}
            runsFailed={runsFailed}
            hidden={unresolved !== undefined}
            instances={instances}
            last={last}
            cannot={cannot}
            actions={actions}
            refused={refused}
          />
        </div>
      ) : null}
    </li>
  );
}

export const Row = memo(RowView);
