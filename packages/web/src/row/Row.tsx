// The task row (A5 3.6, 3.22): the model from `renderRow` drawn in fixed columns. The title is a
// button that expands the row in place; the checkbox, the sources, the folder, the star and the
// launch tile are its siblings, never its children, and never expand it by themselves (a click on
// the summary does, as on the title). A roving tabindex puts only the current row in the tab order:
// its title first, then its other controls.
//
// The row is memoised: it renders again only when its own task, its area or project, its receipts,
// its place in the list or its state (expanded, current, fresh) changes. Every prop it takes is a
// value the list keeps by identity, so a store update that touches one task renders one row.
import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Instance, Receipt } from "../api.ts";
import { Session } from "../context.ts";
import { titleChange } from "../edit/change.ts";
import { whoOf, type Leaving } from "../edit/edits.ts";
import { Unsaved } from "../edit/Unsaved.tsx";
import { useEdits } from "../edit/useEdits.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { useIntl } from "react-intl";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";
import { Expanded } from "../task/Expanded.tsx";
import { placeFact, sourceFacts } from "../task/sources.ts";
import { classes } from "../app/css.ts";
import type { RowActions } from "./actions.ts";
import { tileClick } from "./launch.ts";
import { renderRow, type RowContext, type RowModel } from "./model.ts";
import { sayMsg } from "./say.ts";
import {
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  FolderElsewhereIcon,
  FolderIcon,
  PersonIcon,
  SourceIcon,
  StarIcon,
} from "./icons.tsx";
import css from "./Row.module.css";

const styles = classes(css, [
  "row",
  "line",
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
  "sources",
  "source",
  "more",
  "slot",
  "folder",
  "launch",
  "icon",
  "tile",
  "body",
  "edit",
  "remote",
]);

export interface RowProps {
  readonly task: TaskRow;
  readonly area: AreaRow | undefined;
  readonly slot: number | undefined;
  readonly project: ProjectRow | undefined;
  readonly instances: readonly Instance[];
  readonly receipts: readonly Receipt[];
  readonly ctx: RowContext;
  readonly expanded: boolean;
  /** The row in the tab order (the roving tabindex). */
  readonly current: boolean;
  /** An agent just added it: it fades in (A5 3.15 item 7). */
  readonly fresh: boolean;
  readonly posinset: number;
  readonly setsize: number;
  readonly actions: RowActions;
  /** Checked off and in its hold, or completed by someone else and leaving (A5 3.12). */
  readonly leaving?: Leaving | undefined;
  /** In a virtual list: the item's index and its offset from the list's top, in px. */
  readonly index?: number;
  readonly start?: number;
  readonly measure?: ((element: HTMLElement | null) => void) | undefined;
}

/** A source opens in a new tab with no opener and no referrer (A5 3.26). */
const LINK_REL = ["noopener", "noreferrer"].join(" ");

function Slots({
  model,
  task,
  tab,
  expanded,
  actions,
  t,
}: {
  readonly model: RowModel;
  readonly task: TaskRow;
  readonly tab: number;
  readonly expanded: boolean;
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
        data-tone={model.due?.tone}
        data-tip={model.due === undefined ? undefined : say(model.due.tip)}
      >
        {model.due?.tone === "late" ? <ClockIcon /> : null}
        {model.due === undefined ? null : say(model.due.text)}
      </span>
      <span className={styles.age} data-tip={say(model.age.tip)}>
        {say(model.age.text)}
      </span>
      <span className={styles.prio} data-level={model.priority?.level}>
        {model.priority === undefined ? null : say(model.priority.text)}
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
            data-state={folder.state}
            aria-label={folder.tip === undefined ? undefined : say(folder.tip)}
            aria-disabled={folder.state === "missing" || folder.state === "elsewhere"}
            data-tip={folder.tip === undefined ? undefined : say(folder.tip)}
            tabIndex={tab}
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
          data-tip={t("row.star")}
          tabIndex={tab}
          onClick={() => {
            actions.star(task, !model.starred);
          }}
        >
          <StarIcon />
        </button>
      </span>
      {/* Expanded, the launch slot holds the collapse button: the body owns the launch (A5 3.7). */}
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
        {launch.state === "none" ? null : (
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
            onClick={() => {
              const action = tileClick(launch.state);
              if (action === "open" && launch.instance !== undefined)
                actions.open(task, launch.instance);
              else if (action === "expand") actions.expand(task);
              else if (action === "copy") actions.copy(task);
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
 * The title's editor (A5 3.7, 3.11): Enter or leaving the field saves a changed title, Escape keeps
 * the old one. Either way focus goes back to the title, so the keyboard stays on the row. The save
 * is the person's edit like any other (edits.ts), with the base taken when the editor opened: a
 * title someone else changed while the person typed is a conflict, never overwritten, and the
 * field says so while the person types. Leaving the window is not leaving the field: the editor
 * stays open with what was typed.
 */
function TitleEditor({
  task,
  label,
  onDone,
}: {
  readonly task: TaskRow;
  readonly label: string;
  readonly onDone: () => void;
}) {
  const t = useT();
  const edits = useEdits();
  const { live } = useContext(Session);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Taken once, as the editor opens: the save's base is the title the person began to change.
  const [opened] = useState(() => ({
    base: live.store.asOf,
    mark: edits.mark(),
    title: task.title,
  }));
  const before = opened.title;
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = (field.current?.value ?? "").trim();
    const line = field.current?.closest("[data-row-line]");
    onDone();
    if (keep && title !== "" && title !== before) {
      edits.edit(task, titleChange(title), opened.base === undefined ? {} : { base: opened.base });
    }
    // After React has put the title back.
    requestAnimationFrame(() => {
      line?.querySelector<HTMLElement>('[data-part="title"]')?.focus({ preventScroll: true });
    });
  };
  // Someone else changed the title while the person types: the typed text stays (A5 3.15 item 9).
  const remote =
    task.title === before ? undefined : edits.changedSince(task.id, "title", opened.mark);
  return (
    <span className={styles.edit} data-part="title-editor">
      <input
        ref={field}
        data-part="title-edit"
        aria-label={label}
        defaultValue={before}
        maxLength={500}
        dir="auto"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            // Escape leaves the editor only: the list must not collapse the row.
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => {
          // The window lost focus (another app, another tab): the field keeps it for its return.
          if (!document.hasFocus()) return;
          finish(true);
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
 * After a check-off, focus moves to the next row, or else the previous one, or else the view
 * (A5 3.12): never to a row that is itself leaving.
 */
function focusAfter(from: HTMLElement): void {
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
  receipts,
  ctx,
  expanded,
  current,
  fresh,
  posinset,
  setsize,
  actions,
  leaving,
  index,
  start,
  measure,
}: RowProps) {
  const t = useT();
  const intl = useIntl();
  const place = placeFact(task.place);
  const model = renderRow(
    {
      task,
      ...(area === undefined ? {} : { area: { title: area.title, slot: slot ?? 1 } }),
      ...(project === undefined ? {} : { project: { title: project.title } }),
      instances,
      receipts,
      sources: sourceFacts(t, task.sources),
      ...(task.sources_more === undefined ? {} : { sourcesMore: task.sources_more }),
      ...(place === undefined ? {} : { place }),
    },
    ctx,
  );
  const tab = current ? 0 : -1;
  // Checked: completed, or checked off and in its hold. The box takes a check-off of an open task,
  // and during this tab's own hold, its undo.
  const active = task.lifecycle === "active";
  const checked = leaving === undefined ? !active : leaving.done;
  const checkable = leaving === undefined ? active : leaving.by === undefined;
  const completedTip =
    leaving?.by === undefined
      ? undefined
      : t("row.completedBy", {
          ...whoOf(leaving.by),
          time: intl.formatTime(leaving.at ?? 0, { timeStyle: "short" }),
        });
  const body = `row-${task.id}-body`;
  const described = `row-${task.id}-desc`;
  const toggle = () => {
    actions.toggle(task);
  };
  // The title edits in place, for typo fixes (A5 3.7): only an open task's, the one kind the
  // service changes. Editing expands the row, so the card is what is being edited.
  const [editing, setEditing] = useState(false);
  const edit = () => {
    if (task.lifecycle !== "active") return;
    if (!expanded) actions.expand(task);
    setEditing(true);
  };
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
            />
          )}
        </span>
        <span className={styles.check} data-tip={completedTip} title={completedTip}>
          {/* Check-off is final at once (D12): the row holds, the toast offers Undo (A5 3.12). */}
          <input
            type="checkbox"
            className={styles.box}
            data-part="check"
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
        </span>
        <div className={styles.main}>
          <div className={styles.tline}>
            {editing ? (
              <TitleEditor
                task={task}
                label={t("task.title")}
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
                  if (event.key === "F2") {
                    event.preventDefault();
                    edit();
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
          </div>
          {model.prefix === undefined && model.summary === undefined ? null : (
            // A click on the summary toggles the row like the title, whose button keyboard users reach.
            <div
              className={styles.summary}
              data-part="summary"
              data-tip={expanded ? t("ask.tip") : undefined}
              title={expanded ? t("ask.tip") : undefined}
              onClick={(event) => {
                // Expanded, the summary is an agent's to change: a click asks one (A5 3.11), unless
                // it ends a selection of its text.
                if (expanded) {
                  if (!(window.getSelection()?.isCollapsed ?? true)) return;
                  actions.ask(task, "summary");
                  return;
                }
                // The row becomes current, as if its title had been clicked.
                event.currentTarget
                  .closest("li")
                  ?.querySelector<HTMLElement>('[data-part="title"]')
                  ?.focus({ preventScroll: true });
                toggle();
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
              {model.summary === undefined ? null : (
                <span className={styles.text} dir="auto">
                  {model.summary}
                </span>
              )}
            </div>
          )}
          {expanded ? <Unsaved task={task.id} field="title" /> : null}
        </div>
        <Slots model={model} task={task} tab={tab} expanded={expanded} actions={actions} t={t} />
        <span id={described} hidden>
          {intl.formatList(
            model.description.map((m) => sayMsg(t, m)),
            { type: "unit", style: "short" },
          )}
        </span>
      </div>
      {expanded ? (
        <div className={styles.body} id={body} role="region" aria-label={task.title}>
          <Expanded task={task} receipts={receipts} instances={instances} actions={actions} />
        </div>
      ) : null}
    </li>
  );
}

export const Row = memo(RowView);
