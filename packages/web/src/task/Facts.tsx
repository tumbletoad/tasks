// The expanded task's facts: short muted labels and their controls. An open task's
// facts are edited in place, and every one goes through the one path for a person's edit
// (edit/edits.ts): it shows at once, carries a base, and on a refusal keeps the person's value
// under the control (edit/Unsaved.tsx). A fact without a value is an empty control a person can
// fill. Editable values sit in outlined controls; that outline is the only hint that a value can be
// changed by hand. A finished task's facts are read-only text.
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup, type Key } from "react-aria-components";
import { classes } from "../app/css.ts";
import { ViewIcon } from "../app/Icons.tsx";
import {
  effortChange,
  levelsKey,
  priorityChange,
  statusChange,
  triageChange,
  waitingChange,
  type Field,
} from "../edit/change.ts";
import { whoOf } from "../edit/edits.ts";
import { Unsaved, useUnsaved } from "../edit/Unsaved.tsx";
import { useEdits } from "../edit/useEdits.ts";
import { Session } from "../context.ts";
import { keepTextDraft, letGo, pageLeaving, readTextDraft } from "../unsent.ts";
import { areaSlots, formatDay, formatInstant, type Clock } from "@ttasks/client/today";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import { localDate } from "@ttasks/contracts/day";
import { EFFORT_NAME_MAX } from "@ttasks/contracts/preferences";
import { contextFor, effortLevelOf, levelMsg, renderRow } from "../row/model.ts";
import { sayMsg } from "../row/say.ts";
import { useLive } from "../store/hooks.ts";
import { effortOptions, placeOf, type TaskRow } from "@ttasks/client/store";
import { AreaPicker } from "./AreaPicker.tsx";
import { DuePicker } from "./DuePicker.tsx";
import { useMakeRoutine } from "../routine/actions.ts";
import css from "./Expanded.module.css";

const styles = classes(css, [
  "facts",
  "dot",
  "seg",
  "segButton",
  "move",
  "reopen",
  "waitingField",
  "plain",
  "foot",
  "act",
  "level",
]);

const STATUS_LABEL: Readonly<Record<string, MessageId>> = {
  open: "status.open",
  waiting: "status.waiting",
  review: "status.review",
  backlog: "status.backlog",
};

/** The facts whose unsaved value a finished task still shows, with their labels. */
const UNSAVED_FACTS: readonly (readonly [Field, MessageId])[] = [
  ["status", "fact.status"],
  ["waiting_on", "fact.waitingOn"],
  ["priority", "fact.priority"],
  ["effort", "fact.effort"],
  ["due", "fact.due"],
  ["grouping", "fact.area"],
];

/** The priorities a person sets here: P1 to P3, and none (P4) by choosing the chosen one again. */
const PRIORITIES = [1, 2, 3] as const;

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
  const model = renderRow({ task, instances: [] }, contextFor("open", "flat", clock, []));
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
  const model = renderRow({ task, instances: [] }, contextFor("open", "flat", clock, []));
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
 * A value the person chose before the task was finished stays readable under its fact, with Copy
 * and Discard, until they choose: it is never dropped because someone checked the task off.
 * Reopened, the task's control offers Try again.
 */
function UnsavedFact({
  task,
  field,
  label,
  trashed,
}: {
  readonly task: string;
  readonly field: Field;
  readonly label: string;
  readonly trashed: boolean;
}) {
  if (useUnsaved(task, field).length === 0) return null;
  return (
    <Fact label={label}>
      <Unsaved task={task} field={field} finished trashed={trashed} />
    </Fact>
  );
}

/**
 * A segmented control: one tab stop, the arrows move along it, Space or a click chooses.
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
  /** `tip`: said on resting on the option and to assistive technology, as its description. */
  readonly options: readonly {
    readonly key: string;
    readonly text: string;
    readonly tip?: string;
  }[];
  readonly value: string | undefined;
  readonly clearable: boolean;
  readonly onChange: (value: string | undefined) => void;
}) {
  const ids = useId();
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
      {options.map((option, i) => (
        <ToggleButton
          key={option.key}
          id={option.key}
          className={styles.segButton}
          {...(option.tip === undefined
            ? {}
            : { "data-tip": option.tip, "aria-describedby": `${ids}-${String(i)}` })}
        >
          <span dir="auto">{option.text}</span>
        </ToggleButton>
      ))}
      {options.map((option, i) =>
        option.tip === undefined ? null : (
          <span key={option.key} id={`${ids}-${String(i)}`} hidden>
            {option.tip}
          </span>
        ),
      )}
    </ToggleButtonGroup>
  );
}

/**
 * Who the task waits on: a text field that saves on Enter or when focus leaves it, with the people
 * the space's tasks wait on as suggestions. Escape puts the saved value back. Only what the person
 * typed is sent: its base, what the field showed, is taken when they start to type (again, after
 * an Enter). Until then the field shows the saved value as it changes; after that a change by
 * someone else shows under it while the typed text stays, and leaving or Enter sends the text
 * against what the person saw, so the change is a conflict they choose on. A field that goes away
 * while the person edits it (the card collapses, the task leaves the view) saves what was typed,
 * as leaving it does. What is typed is kept in this tab until it is sent or put back with Escape,
 * so a reload brings it back into the field, sent only once the person types in it or leaves it.
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
  const state = useLive();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const field = useRef<HTMLInputElement>(null);
  const saved = task.waiting_on ?? "";
  // What this tab typed before a reload, unless the field already holds it: its save got there.
  const [brought] = useState(() => {
    const kept = readTextDraft(space, task.id, "waiting_on");
    return kept === undefined || kept.typed.trim() === saved ? undefined : kept;
  });
  /** Set once the person types: the base, the mark and the value they started from. */
  const opened = useRef<{ base: string | undefined; mark: number; value: string } | undefined>(
    brought === undefined
      ? undefined
      : { base: brought.base, mark: edits.mark(), value: brought.before },
  );
  /**
   * What the person typed, for a save when the field goes away under them. Words a reload brought
   * back are not in it: they wait in the field, unsent, until the person types or leaves the field.
   */
  const typed = useRef<string | undefined>(undefined);
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    const kept = readTextDraft(space, task.id, "waiting_on");
    if (brought === undefined && kept !== undefined && !edits.sending(task.id)) {
      letGo(space, { kind: "text", task: task.id, part: "waiting_on", text: kept.typed });
    }
  }, [brought, space, task.id, edits]);
  // A new saved value shows in the field until the person types in it.
  useEffect(() => {
    if (opened.current === undefined && field.current !== null) field.current.value = saved;
  }, [saved]);
  const people = [...new Set([...state.tasks.values()].map((r) => r.waiting_on ?? ""))]
    .filter((p) => p !== "")
    .sort((a, b) => a.localeCompare(b));
  const begin = () => {
    opened.current ??= {
      base: edits.seen(task, ["waiting_on"]),
      mark: edits.mark(),
      value: saved,
    };
  };
  /**
   * Sends what was typed. Leaving the field sends nothing when the text is what the person began
   * from; an Enter (`chosen`) sends it all the same when someone changed the field since.
   */
  const send = (value: string | undefined, chosen = false) => {
    const was = opened.current;
    opened.current = undefined;
    typed.current = undefined;
    const text = (value ?? "").trim();
    const unchanged = chosen ? text === (latest.current.waiting_on ?? "") : text === was?.value;
    if (was === undefined || value === undefined || unchanged) {
      // Nothing to send: the field shows what is saved, also a change made while it was open.
      if (field.current !== null) field.current.value = latest.current.waiting_on ?? "";
      // Left as it was begun: nothing waits. Gone without a word typed: what was kept stays.
      if (was !== undefined && value !== undefined) {
        keepTextDraft(space, task.id, "waiting_on", undefined);
      }
      return;
    }
    edits.edit(latest.current, waitingChange(text === "" ? undefined : text), {
      ...(was.base === undefined ? {} : { base: was.base }),
      settled: () => {
        letGo(space, { kind: "text", task: task.id, part: "waiting_on", text: value });
      },
    });
  };
  const save = (chosen = false) => {
    send(field.current?.value, chosen);
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
  // Someone else changed it while the person edits: the typed text stays.
  const changed =
    opened.current !== undefined && saved !== opened.current.value
      ? (edits.changedSince(task.id, "waiting_on", opened.current.mark)?.by ?? "")
      : undefined;
  return (
    <>
      <input
        ref={field}
        className={styles.waitingField}
        data-part="waiting-on"
        aria-label={t("fact.waitingOn")}
        placeholder={t("fact.waitingPlaceholder")}
        defaultValue={brought?.typed ?? saved}
        list={list}
        maxLength={80}
        dir="auto"
        onFocus={() => {
          onEditing(true);
        }}
        onInput={(event) => {
          // Typing again after an Enter is a new edit, with its own base.
          begin();
          const value = event.currentTarget.value;
          typed.current = value;
          const from = opened.current;
          keepTextDraft(
            space,
            task.id,
            "waiting_on",
            from === undefined || value === from.value
              ? undefined
              : {
                  typed: value,
                  before: from.value,
                  ...(from.base === undefined ? {} : { base: from.base }),
                },
          );
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            save(true);
          } else if (event.key === "Escape" && opened.current !== undefined) {
            // Escape puts the saved value back; a second one leaves for the list.
            if (field.current !== null && field.current.value !== saved) {
              event.preventDefault();
              event.stopPropagation();
              field.current.value = saved;
            }
            opened.current = undefined;
            typed.current = undefined;
            keepTextDraft(space, task.id, "waiting_on", undefined);
          }
        }}
        onBlur={() => {
          // Leaving the window, or the page going away, is not leaving the field: what was typed
          // stays for the return.
          if (!document.hasFocus() || pageLeaving()) return;
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
/**
 * Whether "Repeat…" is offered on a task: on a space that keeps routines, an open task with no task
 * above it and none below.
 */
function repeatable(
  task: TaskRow,
  state: {
    readonly space?: { readonly tree?: true } | undefined;
    readonly tasks: ReadonlyMap<string, TaskRow>;
  },
): boolean {
  if (state.space?.tree !== true || task.lifecycle !== "active") return false;
  if (state.tasks.has(task.parent)) return false;
  for (const other of state.tasks.values()) if (other.parent === task.id) return false;
  return true;
}

export function Facts({ task, clock }: { readonly task: TaskRow; readonly clock: Clock }) {
  const t = useT();
  const state = useLive();
  const edits = useEdits();
  const makeRoutine = useMakeRoutine();
  const { live } = useContext(Session);
  const waitingKept =
    useUnsaved(task.id, "waiting_on").length > 0 ||
    readTextDraft(live.spaceId ?? "", task.id, "waiting_on") !== undefined;
  // Who it waits on stays shown while the person is in it, even when the status moves on.
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [area, project] = placeOf(state.nodes, task.parent);
  const slot = area === undefined ? undefined : areaSlots(state.nodes).get(area.id);
  const due = dueOf(task, clock, t);
  const level = task.priority;
  const priority = level === 1 || level === 2 || level === 3 ? String(level) : undefined;
  const sized = effortLevelOf(task.effort, state.scales.efforts);
  const say = (m: Parameters<typeof sayMsg>[1]) => sayMsg(t, m);

  const trashed = task.deleted_at !== undefined;
  // Move to Trash goes with its button: focus moves to the Restore that takes its place, never to
  // the page.
  const moved = useRef(false);
  const restoreRef = (button: HTMLButtonElement | null): void => {
    if (button === null || !moved.current) return;
    moved.current = false;
    button.focus({ preventScroll: true });
  };
  // At the end of the facts' last line, for an active or a finished task: one change, with its
  // Undo.
  const moveToTrash = (
    <button
      type="button"
      className={styles.act}
      data-part="move-to-trash"
      aria-label={t("fact.trash")}
      data-tip={t("fact.trash")}
      onClick={() => {
        moved.current = true;
        edits.trash(task);
      }}
    >
      <ViewIcon view="trash" />
    </button>
  );
  const created = task.created_at > 0 ? createdOf(task, clock, t) : undefined;
  const foot = (trash: boolean) =>
    created === undefined && !trash ? null : (
      <Fact label={t("fact.created")}>
        <span className={styles.foot}>
          <span>{created}</span>
          {trash ? moveToTrash : null}
        </span>
      </Fact>
    );
  // A finished task's facts are read-only, and so are those of
  // one in the Trash, whose way back is Restore.
  if (task.lifecycle !== "active" || trashed) {
    return (
      <dl className={styles.facts} aria-label={t("fact.label")}>
        <Fact label={t("fact.status")}>
          {trashed ? (
            <>
              <span data-part="in-trash">{t("fact.inTrash")}</span>
              <button
                type="button"
                className={`${styles.move} ${styles.reopen}`}
                data-part="restore"
                ref={restoreRef}
                onClick={() => {
                  edits.restore(task);
                }}
              >
                {t("fact.restore")}
              </button>
            </>
          ) : (
            <>
              <span data-part="lifecycle">{statusOf(task, t)}</span>
              {/* Read-only, apart from this: the way back for a task finished by mistake or too
                    soon. */}
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
            </>
          )}
        </Fact>
        {priority === undefined ? null : (
          <Fact label={t("fact.priority")}>{t("row.priority", { level: Number(priority) })}</Fact>
        )}
        {sized === undefined ? null : (
          <Fact label={t("fact.effort")}>
            <span
              className={styles.level}
              dir="auto"
              data-part="effort"
              data-tip={say(levelMsg(sized))}
              data-long={sized.key.length > EFFORT_NAME_MAX ? "" : undefined}
              aria-description={say(levelMsg(sized))}
              // Focusable, so the keyboard brings up what the level means as the mouse does.
              tabIndex={0}
            >
              {sized.key}
            </span>
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
        {foot(!trashed)}
        {UNSAVED_FACTS.map(([field, label]) => (
          <UnsavedFact
            key={field}
            task={task.id}
            field={field}
            label={t(label)}
            trashed={trashed}
          />
        ))}
      </dl>
    );
  }

  const statuses: string[] = [...state.scales.statuses];
  if (!statuses.includes(task.status)) statuses.push(task.status);
  const efforts = effortOptions(state.scales, task.effort);
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
      {task.status === "waiting" || waitingOpen || waitingKept ? (
        <Fact label={t("fact.waitingOn")}>
          <WaitingOn task={task} onEditing={setWaitingOpen} />
          <Unsaved task={task.id} field="waiting_on" />
        </Fact>
      ) : null}
      <Fact label={t("fact.priority")}>
        <Segmented
          label={t("fact.priority")}
          part="priority"
          options={PRIORITIES.map((n) => ({
            key: String(n),
            text: t("row.priority", { level: n }),
          }))}
          value={priority}
          clearable
          onChange={(next) => {
            // Choosing the chosen one again sets P4: no priority.
            edits.edit(task, priorityChange(next === undefined ? 4 : Number(next)));
          }}
        />
        <Unsaved task={task.id} field="priority" />
      </Fact>
      <Fact label={t("fact.effort")}>
        <Segmented
          label={t("fact.effort")}
          part="effort"
          options={efforts.map((option) => ({
            key: option.key,
            text: option.key,
            tip: say(levelMsg(option)),
          }))}
          value={task.effort === "" ? undefined : task.effort}
          clearable
          onChange={(next) => {
            edits.edit(task, effortChange(next, levelsKey(state.scales.efforts)));
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
          onRepeat={
            repeatable(task, state)
              ? (rule, base) => makeRoutine({ task: task.ref }, rule, clock.timeZone, base)
              : undefined
          }
        />
        <Unsaved task={task.id} field="due" />
      </Fact>
      <Fact label={t("fact.area")}>
        <AreaPicker task={task} />
        <Unsaved task={task.id} field="grouping" />
      </Fact>
      {foot(true)}
    </dl>
  );
}
