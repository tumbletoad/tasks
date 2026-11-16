// The one list component (A5 3.5, 3.22, 3.25): a grouped sequence of items (items.ts) laid out in
// the page's own scroll. Lists over 200 rows are virtualised with TanStack Virtual against the
// window: the visible items plus 10 above and below are mounted, group headings are items too, and
// each item sits at its offset through a custom property set in the CSSOM (no style attribute in
// markup, so the CSP holds). Shorter lists are not virtualised at all. Both modes render the same
// structure with the same keys, so a list that crosses the threshold keeps its rows and focus.
//
// - Rows: a `ul` per project or group, its rows with `aria-posinset` and `aria-setsize`, so a
//   screen reader hears the true size; areas and projects are `role="group"` named by their title.
// - Keyboard: a roving tabindex puts the current row's title in the tab order (Row.tsx). `j`/`k`
//   and the arrows move it, Home and End go to the ends, `[` and `]` to the previous or next
//   group, Escape collapses the expanded row. The current row and the expanded row stay mounted
//   whatever the scroll, so focus is never lost when a row leaves the window and comes back.
// - Focus is sacred (A5 3.15 item 6): a row that holds focus stays in the list until focus leaves
//   it, even when an update takes it out of the view, and an update keeps the focused row (or else
//   the first visible row) at its place on screen.
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { classes } from "../app/css.ts";
import { useT } from "../i18n/intl.tsx";
import css from "./List.module.css";
import {
  moveFrom,
  type GroupItem,
  type Item,
  type Items,
  type RowItem,
  type SectionItem,
} from "./items.ts";

const styles = classes(css, ["list", "group", "head", "dot", "section", "label", "name", "rows"]);

/** Lists over this many rows are virtualised (A5 3.22: "Lists under 200 rows are not"). */
export const VIRTUAL_ABOVE = 200;
/** Items mounted beyond the visible ones, each way (A5 3.25). */
export const OVERSCAN = 10;
/** The sticky top bar's height, and a little air: scrolling keeps rows clear of it. */
const TOP = 64;
const AIR = 8;

/** Where a row is drawn. */
export interface Place {
  readonly current: boolean;
  readonly index?: number;
  readonly start?: number;
  readonly measure?: (element: HTMLElement | null) => void;
}

export interface ListProps {
  readonly items: Items;
  /** The current row's key (its task ID): the one in the tab order. */
  readonly current: string | undefined;
  readonly expanded: string | undefined;
  readonly onCurrent: (key: string) => void;
  readonly onCollapse: () => void;
  readonly row: (item: RowItem, place: Place) => ReactNode;
  /**
   * What an empty list shows instead. A row that holds focus keeps the list, so the view's last row
   * does not vanish under focus; the empty line follows when focus leaves.
   */
  readonly empty?: ReactNode;
}

/**
 * An item's height before it is measured, as the stylesheets lay it out (List.module.css,
 * Row.module.css). Never more than the real height: an estimate that is too tall would leave a
 * gap until the item is measured, one that is right leaves nothing to correct.
 */
const estimate = (item: Item | undefined, expanded: string | undefined): number => {
  if (item === undefined) return 52;
  if (item.kind === "group") return item.first ? 32 : 48;
  if (item.kind === "section") return 34;
  if (item.key === expanded) return 240;
  // 9 + 20 (title) + 9, at least 52; a summary line adds 1 + 18.
  return item.task.summary !== undefined && item.task.summary !== "" ? 57 : 52;
};

/**
 * The items to show. Nothing moves under focus (A5 3.15 item 6): while a row holds focus it keeps
 * its place and its group, so its element (and the focus in it) survives, whatever the update did.
 * A focused row the update took out of the view stays with its last data; one the update moved to
 * another group or project stays under its old heading with its new data; one the update re-sorted
 * inside its list keeps its place there with its new data. It goes where the view puts it once
 * focus leaves.
 */
function withHeld(items: Items, before: Items | undefined, focused: string | undefined): Items {
  if (focused === undefined || before === undefined) return items;
  const at = before.index.get(focused);
  const held = at === undefined ? undefined : before.items[at];
  if (at === undefined || held?.kind !== "row") return items;
  const now = items.index.get(focused);
  const moved = now === undefined ? undefined : items.items[now];
  if (moved?.kind === "row" && moved.group === held.group && moved.section === held.section) {
    return moved.posinset === held.posinset ? items : inPlace(items, moved, held.posinset);
  }
  const kept: RowItem =
    moved?.kind === "row"
      ? { ...held, task: moved.task, area: moved.area, slot: moved.slot, project: moved.project }
      : held;
  const rest = now === undefined ? items.items : items.items.filter((_, i) => i !== now);
  const place = Math.min(at, rest.length);
  const list = [...rest.slice(0, place), kept, ...rest.slice(place)];
  const index = new Map<string, number>();
  list.forEach((item, i) => index.set(item.key, i));
  return { items: list, index, rows: now === undefined ? items.rows + 1 : items.rows };
}

/**
 * The items with a row put back at its old place (1-based) in its own list, the rows of that list
 * numbered again in the order shown, so each still announces its place.
 */
function inPlace(items: Items, row: RowItem, posinset: number): Items {
  const same = (item: Item | undefined): item is RowItem =>
    item?.kind === "row" && item.group === row.group && item.section === row.section;
  const rest = items.items.filter((item) => item.key !== row.key);
  let place = -1;
  let seen = 0;
  for (let i = 0; i < rest.length; i += 1) {
    if (!same(rest[i])) continue;
    seen += 1;
    place = i + 1;
    if (seen === posinset - 1) break;
  }
  // The first of its list: before the list's first row.
  if (posinset <= 1) place = rest.findIndex(same);
  if (place < 0) return items;
  const list: Item[] = [...rest.slice(0, place), row, ...rest.slice(place)];
  let n = 0;
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!same(item)) continue;
    n += 1;
    if (item.posinset !== n) list[i] = { ...item, posinset: n };
  }
  const index = new Map<string, number>();
  list.forEach((item, i) => index.set(item.key, i));
  return { items: list, index, rows: items.rows };
}

interface Bucket<T> {
  readonly key: string;
  readonly item: T | undefined;
  head: number | undefined;
}

interface SectionBucket extends Bucket<SectionItem> {
  readonly rows: number[];
}

interface GroupBucket extends Bucket<GroupItem> {
  readonly sections: SectionBucket[];
}

export function List({
  items: given,
  current: chosen,
  expanded,
  onCurrent,
  onCollapse,
  row,
  empty,
}: ListProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const shownBefore = useRef<Items | undefined>(undefined);
  const shown = useMemo(() => withHeld(given, shownBefore.current, focused), [given, focused]);
  const { items, index } = shown;
  // A held row (focused, out of the view) stays the current row: it keeps the tab order and the
  // keys move on from it. The view's own current row cannot be it, since the view no longer has it.
  const current =
    focused !== undefined && !given.index.has(focused) && index.has(focused) ? focused : chosen;
  const virtual = given.rows > VIRTUAL_ABOVE;
  const [margin, setMargin] = useState(0);

  const currentAt = current === undefined ? undefined : index.get(current);
  const expandedAt = expanded === undefined ? undefined : index.get(expanded);
  const focusedAt = focused === undefined ? undefined : index.get(focused);

  const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);
  const virtualizer = useWindowVirtualizer<HTMLElement>({
    count: virtual ? items.length : 0,
    estimateSize: (i) => estimate(items[i], expanded),
    getItemKey,
    overscan: OVERSCAN,
    scrollMargin: margin,
    scrollPaddingStart: TOP + AIR,
    scrollPaddingEnd: AIR,
    // The current, focused and expanded rows stay mounted wherever the window is.
    rangeExtractor: (range: Range) => {
      const set = new Set(defaultRangeExtractor(range));
      for (const pinned of [currentAt, focusedAt, expandedAt]) {
        if (pinned !== undefined && pinned < range.count) set.add(pinned);
      }
      return [...set].sort((a, b) => a - b);
    },
  });

  // The list's offset in the page: the virtualiser measures from the page's top.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const top = element.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(top - margin) > 0.5) setMargin(top);
  });

  // Scroll anchoring (A5 3.15 item 6): before an update lands, where the anchor row is on screen.
  const anchor = useRef<{ readonly key: string; readonly top: number } | undefined>(undefined);
  const anchored = useRef<Items | undefined>(undefined);
  if (anchored.current !== shown) {
    if (anchored.current !== undefined) anchor.current = readAnchor(root.current, focused);
    anchored.current = shown;
  }
  // After it lands: the same row goes back to the same place.
  useLayoutEffect(() => {
    const before = anchor.current;
    anchor.current = undefined;
    shownBefore.current = shown;
    if (before === undefined) return;
    const at = index.get(before.key);
    if (at === undefined) return;
    let top: number | undefined;
    if (virtual) {
      const measured = virtualizer.measurementsCache[at];
      if (measured !== undefined) top = measured.start - window.scrollY;
    } else {
      top = elementOf(root.current, before.key)?.getBoundingClientRect().top;
    }
    if (top !== undefined && Math.abs(top - before.top) > 0.5) window.scrollBy(0, top - before.top);
  }, [shown, index, virtual, virtualizer]);

  // Focus requested by a key: the row is mounted (it is current), focus it and bring it into view.
  const pending = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = pending.current;
    if (key === undefined) return;
    pending.current = undefined;
    const at = index.get(key);
    const title = elementOf(root.current, key)?.querySelector<HTMLElement>('[data-part="title"]');
    if (at === undefined || title === null || title === undefined) return;
    title.focus({ preventScroll: virtual });
    if (virtual) virtualizer.scrollToIndex(at, { align: "auto" });
  });

  const moveTo = useCallback(
    (at: number | undefined) => {
      const item = at === undefined ? undefined : items[at];
      if (item?.kind !== "row") return;
      pending.current = item.key;
      onCurrent(item.key);
    },
    [items, onCurrent],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const line = target.closest("[data-row-line]");
    if (event.key === "Escape" && expanded !== undefined && !event.defaultPrevented) {
      event.preventDefault();
      pending.current = expanded;
      onCollapse();
      return;
    }
    // A text field in the row (the title being edited) keeps its keys (A5 3.21).
    const typing =
      target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && target.type !== "checkbox");
    if (
      line === null ||
      typing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    const from = current === undefined ? undefined : index.get(current);
    if (from === undefined) return;
    const moves: Readonly<Record<string, Parameters<typeof moveFrom>[2]>> = {
      ArrowDown: "next",
      j: "next",
      ArrowUp: "previous",
      k: "previous",
      Home: "first",
      End: "last",
      "]": "next-group",
      "[": "previous-group",
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    moveTo(moveFrom(items, from, move));
  };

  // Which row holds focus: it is held in place until focus leaves the list.
  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset["key"];
    if (key !== focused) setFocused(key);
  };
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next === null || !event.currentTarget.contains(next)) setFocused(undefined);
  };

  // The items to draw: all of them, or the virtualiser's window.
  const drawn: { index: number; start?: number }[] = virtual
    ? virtualizer.getVirtualItems().map((v) => ({ index: v.index, start: v.start - margin }))
    : items.map((_, i) => ({ index: i }));

  const groups: GroupBucket[] = [];
  const groupsByKey = new Map<string, GroupBucket>();
  const sectionsByKey = new Map<string, SectionBucket>();
  const starts = new Map<number, number | undefined>();
  const groupItem = (key: string) => items[index.get(`g:${key}`) ?? -1] as GroupItem | undefined;
  const bucketOf = (key: string): GroupBucket => {
    let bucket = groupsByKey.get(key);
    if (bucket === undefined) {
      bucket = { key, item: groupItem(key), head: undefined, sections: [] };
      groupsByKey.set(key, bucket);
      groups.push(bucket);
    }
    return bucket;
  };
  const sectionOf = (group: GroupBucket, key: string): SectionBucket => {
    let section = sectionsByKey.get(key);
    if (section === undefined) {
      const at = index.get(key);
      const item = at === undefined ? undefined : items[at];
      section = {
        key,
        item: item?.kind === "section" ? item : undefined,
        head: undefined,
        rows: [],
      };
      sectionsByKey.set(key, section);
      group.sections.push(section);
    }
    return section;
  };
  for (const { index: i, start } of drawn) {
    const item = items[i];
    if (item === undefined) continue;
    starts.set(i, start);
    if (item.kind === "group") bucketOf(item.group.key).head = i;
    else if (item.kind === "section") sectionOf(bucketOf(item.group), item.key).head = i;
    else sectionOf(bucketOf(item.group), item.section).rows.push(i);
  }

  const position = (i: number): CSSProperties | undefined => {
    const start = starts.get(i);
    return start === undefined ? undefined : ({ "--k-y": `${String(start)}px` } as CSSProperties);
  };
  const measure = virtual ? virtualizer.measureElement : undefined;
  const titleOf = (item: GroupItem | undefined): string => {
    if (item === undefined) return "";
    if (item.group.kind === "inbox") return t("group.inbox");
    if (item.group.kind === "loose") return t("group.noArea");
    if (item.group.label !== undefined) return t(item.group.label);
    return item.group.title ?? "";
  };
  const total = virtual ? virtualizer.getTotalSize() : undefined;

  if (shown.rows === 0 && empty !== undefined) return empty;
  return (
    <div
      ref={root}
      className={styles.list}
      data-list=""
      data-virtual={virtual}
      style={total === undefined ? undefined : ({ "--k-h": `${String(total)}px` } as CSSProperties)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {groups.map((group) => {
        const title = titleOf(group.item);
        // Today's sections are `section` elements (A5 3.22), named like every group by aria-label:
        // a virtualised list may have unmounted the heading. A flat group has no item, no heading
        // and no name: its rows are the view's own list.
        const kind = group.item?.group.kind;
        const isSection = kind === "section";
        const Wrapper = isSection ? "section" : "div";
        return (
          <Wrapper
            key={group.key}
            className={styles.group}
            role={isSection || group.item === undefined ? undefined : "group"}
            aria-label={group.item === undefined ? undefined : title}
            data-section={isSection ? group.key : undefined}
          >
            {group.head === undefined ? null : (
              <h2
                ref={measure}
                className={styles.head}
                data-index={group.head}
                data-key={`g:${group.key}`}
                data-first={group.item?.first}
                data-kind={group.item?.group.kind}
                style={position(group.head)}
              >
                {isSection || kind === "label" ? null : (
                  <span
                    className={
                      group.item?.group.slot === undefined
                        ? styles.dot
                        : `${styles.dot} slot-${String(group.item.group.slot)}`
                    }
                    aria-hidden="true"
                  />
                )}
                <span className={styles.name} dir="auto">
                  {title}
                </span>
              </h2>
            )}
            {group.sections.map((section) => (
              <div
                key={section.key}
                className={styles.section}
                role={section.item === undefined ? undefined : "group"}
                aria-label={section.item?.title}
              >
                {section.head === undefined || section.item === undefined ? null : (
                  <h3
                    ref={measure}
                    className={styles.label}
                    data-index={section.head}
                    data-key={section.key}
                    style={position(section.head)}
                  >
                    <span className={styles.name} dir="auto">
                      {section.item.title}
                    </span>
                  </h3>
                )}
                <ul className={styles.rows}>
                  {section.rows.map((i) => {
                    const item = items[i] as RowItem;
                    const start = starts.get(i);
                    return row(item, {
                      current: item.key === current,
                      ...(measure === undefined ? {} : { index: i, measure }),
                      ...(start === undefined ? {} : { start }),
                    });
                  })}
                </ul>
              </div>
            ))}
          </Wrapper>
        );
      })}
    </div>
  );
}

function elementOf(root: HTMLElement | null, key: string): HTMLElement | undefined {
  return root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? undefined;
}

/**
 * The row to keep in place across an update, and where it is on screen now: the focused row, or
 * else the first item below the top bar.
 */
function readAnchor(
  root: HTMLElement | null,
  focused: string | undefined,
): { key: string; top: number } | undefined {
  if (root === null) return undefined;
  if (focused !== undefined) {
    const element = elementOf(root, focused);
    if (element !== undefined) return { key: focused, top: element.getBoundingClientRect().top };
  }
  let best: { key: string; top: number } | undefined;
  for (const element of root.querySelectorAll<HTMLElement>("[data-key]")) {
    const rect = element.getBoundingClientRect();
    const key = element.dataset["key"];
    if (key === undefined || rect.bottom <= TOP || rect.top >= window.innerHeight) continue;
    if (best === undefined || rect.top < best.top) best = { key, top: rect.top };
  }
  return best;
}
