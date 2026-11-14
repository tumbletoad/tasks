// The task row (A5 3.6, 3.22): the model from `renderRow` drawn in fixed columns. The title is a
// button that expands the row in place; the checkbox, the sources, the folder, the star and the
// launch tile are its siblings, never its children, and never expand it by themselves (a click on
// the summary does, as on the title). A roving tabindex puts only the current row in the tab order:
// its title first, then its other controls.
//
// The row is memoised: it renders again only when its own task, its area or project, its receipts,
// its place in the list or its state (expanded, current, fresh) changes. Every prop it takes is a
// value the list keeps by identity, so a store update that touches one task renders one row.
import { memo, type CSSProperties } from "react";
import type { Instance, Receipt } from "../api.ts";
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
  actions,
  t,
}: {
  readonly model: RowModel;
  readonly task: TaskRow;
  readonly tab: number;
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
  const body = `row-${task.id}-body`;
  const described = `row-${task.id}-desc`;
  const toggle = () => {
    actions.toggle(task);
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
        <span className={styles.check}>
          {/* Check-off with its hold, toast and undo is M5.08's: until then the box is shown, not used. */}
          <input
            type="checkbox"
            className={styles.box}
            aria-label={sayMsg(t, model.done)}
            disabled
            tabIndex={tab}
          />
        </span>
        <div className={styles.main}>
          <div className={styles.tline}>
            <button
              type="button"
              className={styles.title}
              data-part="title"
              aria-expanded={expanded}
              aria-controls={expanded ? body : undefined}
              aria-describedby={described}
              tabIndex={tab}
              onClick={toggle}
            >
              <span dir="auto">{model.title}</span>
            </button>
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
              onClick={(event) => {
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
        </div>
        <Slots model={model} task={task} tab={tab} actions={actions} t={t} />
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
