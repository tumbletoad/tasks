// The expanded task's facts (A5 3.7, 3.11): short muted labels and their controls. An open task's
// facts are edited in place, and every one goes through the one path for a person's edit
// (edit/edits.ts): it shows at once, carries a base, and on a refusal keeps the person's value
// under the control (edit/Unsaved.tsx). A fact without a value is an empty control a person can
// fill. Editable values sit in outlined controls; that outline is the only hint that a value can be
// changed by hand. A finished task's facts are read-only text.
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup, type Key } from "react-aria-components";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import {
  effortChange,
  priorityChange,
  statusChange,
  triageChange,
  waitingChange,
  type Field,
} from "../edit/change.ts";
import { whoOf } from "../edit/edits.ts";
import { Unsaved } from "../edit/Unsaved.tsx";
import { useEditState, useEdits } from "../edit/useEdits.ts";
import { areaSlots } from "../groups.ts";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import { formatDay, formatInstant, localDate, type Clock } from "../row/dates.ts";
import { contextFor, renderRow } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
import { AreaPicker } from "./AreaPicker.tsx";
import { DuePicker } from "./DuePicker.tsx";
import css from "./Expanded.module.css";

const styles = classes(css, [
  "facts",
  "dot",
  "seg",
  "segButton",
  "move",
  "reopen",
  "waitingOn",
  "plain",
]);

const STATUS_LABEL: Readonly<Record<string, MessageId>> = {
  open: "status.open",
  waiting: "status.waiting",
  review: "status.review",
  backlog: "status.backlog",
};

/** The space's statuses (`tasks.statuses`): the defaults until the snapshot carries the preference. */
const STATUSES = ["open", "waiting", "review", "backlog"] as const;
/** The facts whose unsaved value a finished task still shows, with their labels. */
const UNSAVED_FACTS: readonly (readonly [Field, MessageId])[] = [
  ["status", "fact.status"],
  ["waiting_on", "fact.waitingOn"],
  ["priority", "fact.priority"],
  ["effort", "fact.effort"],
  ["due", "fact.due"],
  ["grouping", "fact.area"],
];

/** The space's effort scale (`tasks.effort_scale`): the default until the snapshot carries it. */
const EFFORTS = ["S", "M", "L"] as const;

/** The status fact: the lifecycle for a finished task, Inbox, else the status's name. */
function statusOf(task: TaskRow, t: Translate): string {
  if (task.lifecycle === "completed") return t("status.completed");
  if (task.lifecycle === "archived") return t("status.archived");
  if (task.inbox) return t("status.inbox");
  const label = STATUS_LABEL[task.status];
  return label === undefined ? task.status : t(label);
}

/** "Fri 13 Nov", with the year when it is not this year; the catalogue orders the parts. */
export function shortDate(date: string, clock: Clock, t: Translate): string {
  const options = (o: Intl.DateTimeFormatOptions) => formatDay(date, clock.locale, o);
  const values = {
    weekday: options({ weekday: "short" }),
    day: Number(date.slice(8, 10)),
    month: options({ month: "short" }),
    year: date.slice(0, 4),
  };
  return date.slice(0, 4) === clock.today.slice(0, 4)
    ? t("row.fullDate", values)
    : t("row.fullDateYear", values);
}

/** The due fact: its date (and time), with the row's relative words as the tooltip. */
function dueOf(
  task: TaskRow,
  clock: Clock,
  t: Translate,
): { text: string; tip: string } | undefined {
  const model = renderRow({ task, instances: [], receipts: [] }, contextFor("open", "flat", clock));
  const relative = model.due === undefined ? "" : sayMsg(t, model.due.text);
  if (task.due_at !== undefined) {
    const date = shortDate(localDate(task.due_at, clock.timeZone), clock, t);
    const time = formatInstant(task.due_at, clock, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return { text: t("fact.dueAt", { date, time }), tip: relative };
  }
  if (task.due_date !== undefined) {
    return { text: shortDate(task.due_date, clock, t), tip: relative };
  }
  return undefined;
}

/** The created fact: "9 Nov · 3d", the only place a task's age shows while it is expanded. */
function createdOf(task: TaskRow, clock: Clock, t: Translate): string {
  const model = renderRow({ task, instances: [], receipts: [] }, contextFor("open", "flat", clock));
  const date = localDate(task.created_at, clock.timeZone);
  // Created today: "today" alone, so today's date stays the strip's (A5 U1).
  const age = model.age === undefined ? "" : sayMsg(t, model.age.text);
  if (date === clock.today) return age;
  const day = formatDay(date, clock.locale, { day: "numeric" });
  const month = formatDay(date, clock.locale, { month: "short" });
  const shown =
    date.slice(0, 4) === clock.today.slice(0, 4)
      ? t("row.date", { day, month })
      : t("row.dateYear", { day, month, year: date.slice(0, 4) });
  return t("fact.createdValue", { date: shown, age });
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-fact="">{children}</dd>
    </>
  );
}

/**
 * A segmented control (A5 3.7): one tab stop, the arrows move along it, Space or a click chooses.
 * A clearable one clears when its chosen option is chosen again.
 */
function Segmented({
  label,
  part,
  options,
  value,
  clearable,
  onChange,
}: {
  readonly label: string;
  readonly part: string;
  readonly options: readonly { readonly key: string; readonly text: string }[];
  readonly value: string | undefined;
  readonly clearable: boolean;
  readonly onChange: (value: string | undefined) => void;
}) {
  return (
    <ToggleButtonGroup
      className={styles.seg}
      data-part={part}
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection={!clearable}
      selectedKeys={value === undefined ? [] : [value]}
      onSelectionChange={(keys: Set<Key>) => {
        const [key] = [...keys];
        const next = key === undefined ? undefined : String(key);
        if (next !== value) onChange(next);
      }}
    >
      {options.map((option) => (
        <ToggleButton key={option.key} id={option.key} className={styles.segButton}>
          <span dir="auto">{option.text}</span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/**
 * Who the task waits on: a text field that saves on Enter or when focus leaves it, with the people
 * the space's tasks wait on as suggestions. Escape puts the saved value back. Its base is taken
 * when the person starts to type (again, after an Enter), and a change by someone else meanwhile
 * shows under it while the typed text stays. A field that goes away while the person edits it
 * (the card collapses, the task leaves the view) saves what was typed, as leaving it does.
 */
function WaitingOn({
  task,
  onEditing,
}: {
  readonly task: TaskRow;
  /** The person is in the field: the fact stays shown while they are, whatever the status. */
  readonly onEditing: (editing: boolean) => void;
}) {
  const t = useT();
  const edits = useEdits();
  const { live } = useContext(Session);
  const state = useLive();
  const field = useRef<HTMLInputElement>(null);
  /** Set while the person edits the field: the base, the mark and the value they started from. */
  const opened = useRef<{ base: string | undefined; mark: number; value: string } | undefined>(
    undefined,
  );
  /** What the person typed, for a save when the field goes away under them. */
  const typed = useRef<string | undefined>(undefined);
  const latest = useRef(task);
  latest.current = task;
  const saved = task.waiting_on ?? "";
  // A new saved value shows in the field only while the person is not editing it.
  useEffect(() => {
    if (opened.current === undefined && field.current !== null) field.current.value = saved;
  }, [saved]);
  const people = [...new Set([...state.tasks.values()].map((r) => r.waiting_on ?? ""))]
    .filter((p) => p !== "")
    .sort((a, b) => a.localeCompare(b));
  const begin = () => {
    opened.current ??= { base: live.store.asOf, mark: edits.mark(), value: saved };
  };
  const send = (value: string | undefined) => {
    const was = opened.current;
    opened.current = undefined;
    typed.current = undefined;
    const text = (value ?? "").trim();
    if (was === undefined || value === undefined || text === was.value) return;
    edits.edit(
      latest.current,
      waitingChange(text === "" ? undefined : text),
      was.base === undefined ? {} : { base: was.base },
    );
  };
  const save = () => {
    send(field.current?.value);
  };
  // Gone under the person: what they typed is saved, never dropped. `send` reads only refs.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(
    () => () => {
      sendRef.current(typed.current);
    },
    [],
  );
  const list = `waiting-people-${task.id}`;
  // Someone else changed it while the person edits: the typed text stays (A5 3.15 item 9).
  const changed =
    opened.current !== undefined && saved !== opened.current.value
      ? (edits.changedSince(task.id, "waiting_on", opened.current.mark)?.by ?? "")
      : undefined;
  return (
    <>
      <input
        ref={field}
        className={styles.waitingOn}
        data-part="waiting-on"
        aria-label={t("fact.waitingOn")}
        placeholder={t("fact.waitingPlaceholder")}
        defaultValue={saved}
        list={list}
        maxLength={80}
        dir="auto"
        onFocus={() => {
          begin();
          onEditing(true);
        }}
        onInput={(event) => {
          // Typing again after an Enter is a new edit, with its own base.
          begin();
          typed.current = event.currentTarget.value;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          } else if (event.key === "Escape" && opened.current !== undefined) {
            // Escape puts the saved value back; a second one leaves for the list.
            if (field.current !== null && field.current.value !== saved) {
              event.preventDefault();
              event.stopPropagation();
              field.current.value = saved;
            }
            opened.current = undefined;
            typed.current = undefined;
          }
        }}
        onBlur={() => {
          // Leaving the window is not leaving the field: what was typed stays for the return.
          if (!document.hasFocus()) return;
          save();
          onEditing(false);
        }}
      />
      <datalist id={list}>
        {people.map((person) => (
          <option key={person} value={person} />
        ))}
      </datalist>
      {changed === undefined ? null : (
        <span className={styles.plain} role="status" data-part="remote">
          {t("edit.changedBy", whoOf(changed))}
        </span>
      )}
    </>
  );
}
export function Facts({ task, clock }: { readonly task: TaskRow; readonly clock: Clock }) {
  const t = useT();
  const state = useLive();
  const edits = useEdits();
  // Re-rendered when an unsaved value comes or goes.
  useEditState();
  // Who it waits on stays shown while the person is in it, even when the status moves on.
  const [waitingOpen, setWaitingOpen] = useState(false);
  const area = task.area_id === undefined ? undefined : state.areas.get(task.area_id);
  const project = task.project_id === undefined ? undefined : state.projects.get(task.project_id);
  const slot = area === undefined ? undefined : areaSlots(state.areas.values()).get(area.id);
  const due = dueOf(task, clock, t);
  const level = task.priority;
  const priority = level === 1 || level === 2 || level === 3 ? String(level) : undefined;

  // A finished task's facts are read-only (A5 3.5 "Expanded completed task").
  if (task.lifecycle !== "active") {
    return (
      <dl className={styles.facts} aria-label={t("fact.label")}>
        <Fact label={t("fact.status")}>
          <span data-part="lifecycle">{statusOf(task, t)}</span>
          {task.deleted_at === undefined ? (
            // Read-only, apart from this: the way back for a task finished by mistake or too soon.
            <button
              type="button"
              className={`${styles.move} ${styles.reopen}`}
              data-part="reopen"
              onClick={() => {
                edits.reopen(task);
              }}
            >
              {t("fact.reopen")}
            </button>
          ) : null}
        </Fact>
        {priority === undefined ? null : (
          <Fact label={t("fact.priority")}>{t("row.priority", { level: Number(priority) })}</Fact>
        )}
        {task.effort === undefined || task.effort === "" ? null : (
          <Fact label={t("fact.effort")}>
            <span dir="auto">{task.effort}</span>
          </Fact>
        )}
        {due === undefined ? null : (
          <Fact label={t("fact.due")}>
            <span data-tip={due.tip}>{due.text}</span>
          </Fact>
        )}
        {area === undefined ? null : (
          <Fact label={t("fact.area")}>
            <span
              className={`${styles.dot} slot-${String(slot ?? 1)}`}
              aria-hidden="true"
              data-slot={slot}
            />
            <span dir="auto">
              {project === undefined
                ? area.title
                : t("fact.areaProject", { area: area.title, project: project.title })}
            </span>
          </Fact>
        )}
        {task.created_at > 0 ? (
          <Fact label={t("fact.created")}>{createdOf(task, clock, t)}</Fact>
        ) : null}
        {/* A value the person chose before the task was finished stays readable here, with Copy
            and Discard, until they choose: it is never dropped because someone checked the task
            off. Reopened, the task's control offers Try again. */}
        {UNSAVED_FACTS.map(([field, label]) => {
          const unsaved = edits.unsaved(task.id, field);
          if (unsaved === undefined) return null;
          const shown = unsaved.change.shown;
          return (
            <Fact key={field} label={t(label)}>
              <span dir="auto" data-part="unsaved-value">
                {typeof shown === "string" ? shown : sayMsg(t, shown)}
              </span>
              <Unsaved task={task.id} field={field} finished />
            </Fact>
          );
        })}
      </dl>
    );
  }

  const statuses: string[] = [...STATUSES];
  if (!statuses.includes(task.status)) statuses.push(task.status);
  const efforts: string[] = [...EFFORTS];
  if (task.effort !== undefined && task.effort !== "" && !efforts.includes(task.effort)) {
    efforts.push(task.effort);
  }
  return (
    <dl className={styles.facts} aria-label={t("fact.label")} data-editable="">
      <Fact label={t("fact.status")}>
        <Segmented
          label={t("fact.status")}
          part="status"
          options={statuses.map((key) => {
            const id = STATUS_LABEL[key];
            return { key, text: id === undefined ? key : t(id) };
          })}
          value={task.status}
          clearable={false}
          onChange={(status) => {
            if (status !== undefined) edits.edit(task, statusChange(status));
          }}
        />
        {task.inbox ? (
          <button
            type="button"
            className={styles.move}
            data-part="triage"
            onClick={() => {
              edits.edit(task, triageChange());
            }}
          >
            {t("fact.moveToOpen")}
          </button>
        ) : null}
        <Unsaved task={task.id} field="status" />
      </Fact>
      {task.status === "waiting" ||
      waitingOpen ||
      edits.unsaved(task.id, "waiting_on") !== undefined ? (
        <Fact label={t("fact.waitingOn")}>
          <WaitingOn task={task} onEditing={setWaitingOpen} />
          <Unsaved task={task.id} field="waiting_on" />
        </Fact>
      ) : null}
      <Fact label={t("fact.priority")}>
        <Segmented
          label={t("fact.priority")}
          part="priority"
          options={[1, 2, 3].map((n) => ({
            key: String(n),
            text: t("row.priority", { level: n }),
          }))}
          value={priority}
          clearable
          onChange={(next) => {
            // Choosing the chosen one again sets P4: no priority (A5 3.7).
            edits.edit(task, priorityChange(next === undefined ? 4 : Number(next)));
          }}
        />
        <Unsaved task={task.id} field="priority" />
      </Fact>
      <Fact label={t("fact.effort")}>
        <Segmented
          label={t("fact.effort")}
          part="effort"
          options={efforts.map((key) => ({ key, text: key }))}
          value={task.effort === "" ? undefined : task.effort}
          clearable
          onChange={(next) => {
            edits.edit(task, effortChange(next));
          }}
        />
        <Unsaved task={task.id} field="effort" />
      </Fact>
      <Fact label={t("fact.due")}>
        <DuePicker
          task={task}
          clock={clock}
          shown={due?.text}
          tip={due?.tip}
          shortOf={(date) => shortDate(date, clock, t)}
        />
        <Unsaved task={task.id} field="due" />
      </Fact>
      <Fact label={t("fact.area")}>
        <AreaPicker task={task} />
        <Unsaved task={task.id} field="grouping" />
      </Fact>
      {task.created_at > 0 ? (
        <Fact label={t("fact.created")}>{createdOf(task, clock, t)}</Fact>
      ) : null}
    </dl>
  );
}
