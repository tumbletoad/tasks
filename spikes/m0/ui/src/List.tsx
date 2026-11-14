// The virtualised task list (A5 3.24, 3.25): TanStack Virtual, fixed row heights for collapsed
// rows (52 px comfortable, A5 3.20), group headings as virtual items, and 10 rows of overscan above
// and below (A5 3.25: "the visible ones plus 10 above and below").
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Area, Item, Project } from "./data.ts";
import { Row } from "./Row.tsx";

export const ROW_HEIGHT = 52;
export const AREA_HEIGHT = 40;
export const PROJECT_HEIGHT = 32;
export const OVERSCAN = 10;

const sizeOf = (item: Item | undefined) =>
  item?.kind === "area" ? AREA_HEIGHT : item?.kind === "project" ? PROJECT_HEIGHT : ROW_HEIGHT;

/** What the measurement reads from the list after each render. */
export interface ListHandle {
  scroller: HTMLDivElement | null;
  /** How many items the last render put in the DOM. */
  rendered: number;
  /** The task ids in the DOM after the last render. */
  visibleTaskIds: number[];
}

export interface ListProps {
  items: readonly Item[];
  areas: readonly Area[];
  projects: readonly Project[];
  grouped: boolean;
  taskCount: number;
  handle: ListHandle;
  onCommit?: () => void;
}

export function List({
  items,
  areas,
  projects,
  grouped,
  taskCount,
  handle,
  onCommit,
}: ListProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => sizeOf(items[index]),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: OVERSCAN,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const ids: number[] = [];
  const children = virtualItems.map((virtual) => {
    const item = items[virtual.index];
    if (item === undefined) return null;
    const transform = { transform: `translateY(${String(virtual.start)}px)` };
    if (item.kind === "area") {
      const area = areas[item.area];
      return (
        <div key={item.key} className="group area" role="presentation" style={transform}>
          <span className={`area-dot a${String(area?.slot ?? 1)}`} />
          {area?.name}
        </div>
      );
    }
    if (item.kind === "project") {
      return (
        <div key={item.key} className="group project" role="presentation" style={transform}>
          {projects[item.project]?.name}
        </div>
      );
    }
    ids.push(item.task.id);
    return (
      <Row
        key={item.key}
        task={item.task}
        areas={areas}
        projects={projects}
        grouped={grouped}
        setSize={taskCount}
        position={item.pos}
        top={virtual.start}
      />
    );
  });
  handle.rendered = virtualItems.length;
  handle.visibleTaskIds = ids;
  useLayoutEffect(() => {
    handle.scroller = scroller.current;
    onCommit?.();
  });
  return (
    <div className="scroller" ref={scroller} tabIndex={-1}>
      <div
        className="spacer"
        role="list"
        aria-label="Tasks"
        style={{ height: `${String(virtualizer.getTotalSize())}px` }}
      >
        {children}
      </div>
    </div>
  );
}
