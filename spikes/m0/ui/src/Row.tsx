// The collapsed task row of A5 3.6 at spike level: marker, check, title and summary, then the fixed
// columns due, age, priority, sources, folder, star and the launch tile. Memoised by task object,
// which changes only when an event changes the task (A5 3.25: an event re-renders only its rows).
import { memo, type ReactNode } from "react";
import type { Area, Project, SourceKind, Task } from "./data.ts";

const MONOGRAMS = ["Cc", "Cx", "T3"] as const;

function dueText(due: number | null): { text: string; tone: string } | null {
  if (due === null) return null;
  if (due < 0) return { text: `${String(-due)}d late`, tone: "late" };
  if (due === 0) return { text: "Today", tone: "soon" };
  if (due === 1) return { text: "Tomorrow", tone: "soon" };
  const date = new Date(2026, 10, 12 + due);
  if (due <= 6) {
    return {
      text: `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${String(date.getDate())}`,
      tone: "soon",
    };
  }
  return {
    text: date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    tone: "later",
  };
}

function ageText(days: number): string {
  if (days === 0) return "today";
  if (days < 7) return `${String(days)}d`;
  if (days < 60) return `${String(Math.floor(days / 7))}w`;
  if (days < 365) return `${String(Math.floor(days / 30))}mo`;
  return `${String(Math.floor(days / 365))}y`;
}

function Icon({ d, filled = false }: { d: string; filled?: boolean }): ReactNode {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
    >
      <path d={d} />
    </svg>
  );
}

const SOURCE_ICON: Record<SourceKind, string> = {
  mail: "M3 6h18v12H3z M3 6l9 7 9-7",
  chat: "M4 5h16v11H9l-5 4z",
  ticket: "M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z",
  pr: "M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M18 9v12 M18 3a3 3 0 1 0 0 6",
  doc: "M6 3h9l4 4v14H6z M14 3v5h5",
  calendar: "M4 6h16v15H4z M4 10h16 M8 3v5 M16 3v5",
  link: "M10 14l4-4 M8 16a4 4 0 0 1 0-6l2-2 M16 8a4 4 0 0 1 0 6l-2 2",
};
const STAR = "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z";
const FOLDER = "M3 6h6l2 2h10v11H3z";

export interface RowProps {
  task: Task;
  areas: readonly Area[];
  projects: readonly Project[];
  /** The view already states the area and project (grouped view), so the row leaves them out. */
  grouped: boolean;
  setSize: number;
  position: number;
  top: number;
}

function RowView({ task, areas, projects, grouped, setSize, position, top }: RowProps): ReactNode {
  const due = dueText(task.due);
  const area = areas[task.area];
  const project = projects[task.project];
  const extra = task.sources.length - 3;
  return (
    <div
      className="row"
      role="listitem"
      aria-setsize={setSize}
      aria-posinset={position}
      data-row={task.ref}
      style={{ transform: `translateY(${String(top)}px)` }}
    >
      <span className="zone-marker">
        {task.marker === "input" ? <span className="ring" title="Needs your input" /> : null}
        {task.marker === "changed" ? <span className="dot" title="Changed by an agent" /> : null}
      </span>
      <span className="zone-check">
        <input type="checkbox" aria-label={`Done: ${task.title}`} />
      </span>
      <div className="zone-main">
        <div className="line1">
          <button type="button" className="title">
            {task.title}
          </button>
          {task.status === "waiting" ? (
            <span className="chip waiting">{task.waitingOn}</span>
          ) : null}
          {task.status === "review" ? <span className="chip review">Review</span> : null}
          {task.status === "backlog" ? <span className="chip">Backlog</span> : null}
        </div>
        <div className="line2">
          {grouped ? null : (
            <span className="prefix">
              <span className={`area-dot a${String(area?.slot ?? 1)}`} />
              {project?.name} ·{" "}
            </span>
          )}
          {task.summary}
        </div>
      </div>
      <span className={`zone-due ${due?.tone ?? ""}`}>{due?.text}</span>
      <span className="zone-age">{ageText(task.age)}</span>
      <span className="zone-prio">
        {task.priority === 1 ? (
          <span className="p1">P1</span>
        ) : task.priority < 4 ? (
          `P${String(task.priority)}`
        ) : null}
      </span>
      <span className="zone-sources">
        {task.sources.slice(0, 3).map((kind, i) => (
          <Icon key={i} d={SOURCE_ICON[kind]} />
        ))}
        {extra > 0 ? <span className="more">+{extra}</span> : null}
      </span>
      <span className="zone-folder">
        {task.place === "none" ? null : (
          <button
            type="button"
            className={`icon-button ${task.place === "here" ? "" : "dim"}`}
            aria-label="Open folder"
          >
            <Icon d={FOLDER} />
          </button>
        )}
      </span>
      <span className="zone-star">
        <button
          type="button"
          className={`icon-button ${task.starred ? "starred" : ""}`}
          aria-label="Star"
        >
          <Icon d={STAR} filled={task.starred} />
        </button>
      </span>
      <span className="zone-launch">
        <button type="button" className={`tile r${String(task.instance + 1)}`} aria-label="Open">
          {MONOGRAMS[task.instance]}
        </button>
      </span>
    </div>
  );
}

export const Row = memo(
  RowView,
  (a, b) =>
    a.task === b.task &&
    a.grouped === b.grouped &&
    a.top === b.top &&
    a.position === b.position &&
    a.setSize === b.setSize,
);
