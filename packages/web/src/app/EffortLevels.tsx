// The space's effort levels in Settings: a small grid in which a person adds, renames, times,
// describes, reorders and removes levels. Each change saves at once through `prefs.manage`, with
// the moves that carry its tasks along, shows at once as an overlay, and its toast offers Undo. The
// one question is where the tasks of a removed level go. A text field saves on Enter or when it is
// left, never per keystroke.
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button, Heading, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import {
  checkEffortMoves,
  EFFORT_ABOUT_MAX,
  EFFORT_NAME_MAX,
  EFFORT_SCALE_MAX,
  EFFORT_UNITS,
  type EffortHeld,
  type EffortLevel,
  type EffortUnit,
} from "@ttasks/contracts/preferences";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import type { WriteReceipt } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT, type Translate } from "../i18n/intl.tsx";
import type { TaskRow } from "../live.ts";
import type { Msg } from "../row/model.ts";
import { useLive } from "../store/hooks.ts";
import type { Overlay, TaskOverlay } from "../store/pending.ts";
import { classes } from "./css.ts";
import { useToast } from "./frame.ts";
import { CrossIcon, DownIcon, MoreIcon, PlusIcon, UpIcon } from "./Icons.tsx";
import {
  heldBy,
  heldCount,
  levelsWrite,
  moveTarget,
  nameProblem,
  oneLine,
  type LevelEdit,
  type LevelsWrite,
  type NameProblem,
} from "./levels.ts";
import css from "./EffortLevels.module.css";

const styles = classes(css, [
  "about",
  "act",
  "actions",
  "add",
  "ask",
  "askLine",
  "cell",
  "count",
  "fixed",
  "foot",
  "head",
  "input",
  "item",
  "lead",
  "level",
  "levels",
  "line",
  "list",
  "menu",
  "more",
  "name",
  "problem",
  "select",
  "time",
  "unit",
]);

const KEY = "tasks.effort_scale";
/** The description's length from which the field says how much room is left. */
const ABOUT_COUNT_FROM = 240;
/** The move question's "No size": no level is ever called this. */
const NO_SIZE = "";

/** How a save ended: the cells keep their text unless it was saved. */
type Outcome = "saved" | "same" | "asked" | "conflict" | "failed";

const PROBLEMS: Readonly<Record<NameProblem, (t: Translate, name: string) => string>> = {
  empty: (t) => t("levels.empty"),
  characters: (t) => t("levels.characters"),
  taken: (t, name) => t("levels.taken", { name }),
  long: (t) => t("levels.long", { max: EFFORT_NAME_MAX }),
};

/** The write shown at once: the new levels, and the rows on screen that move along. */
function overlayOf(write: LevelsWrite, tasks: ReadonlyMap<string, TaskRow>): Overlay {
  const moved = new Map(write.moves.filter((m) => m.to !== m.from).map((m) => [m.from, m.to]));
  const rows: TaskOverlay[] = [];
  if (moved.size > 0) {
    for (const row of tasks.values()) {
      const to = row.effort === undefined ? undefined : moved.get(row.effort);
      if (to === undefined) continue;
      rows.push(
        to === null
          ? { id: row.id, set: {}, clear: ["effort"] }
          : { id: row.id, set: { effort: to } },
      );
    }
  }
  return { tasks: rows, efforts: write.value };
}

interface SetAnswer {
  readonly as_of?: string;
  readonly result?: unknown;
  readonly moved?:
    | readonly { readonly active: number; readonly finished: number; readonly trash: number }[]
    | undefined;
  readonly off_list?:
    readonly { readonly tasks: readonly string[]; readonly count: number }[] | undefined;
}

/** The toast of a saved change: what it did, and the tasks it moved or left off the levels. */
function savedMsg(
  edit: LevelEdit,
  now: readonly EffortLevel[],
  result: SetAnswer | WriteReceipt,
): Msg {
  const answer: SetAnswer = "receipt" in result ? {} : result;
  const moved = (answer.moved ?? []).reduce((n, m) => n + m.active + m.finished + m.trash, 0);
  const off = answer.off_list ?? [];
  const was = edit.kind === "add" ? "" : (now[edit.at]?.key ?? "");
  const to = edit.kind === "remove" ? edit.to : undefined;
  return {
    id: "levels.saved",
    values: {
      kind: edit.kind,
      name: edit.kind === "add" || edit.kind === "rename" ? edit.name : was,
      from: was,
      moved,
      how: edit.kind === "rename" ? "with" : to === null ? "none" : "to",
      to: to ?? "",
      count: off.reduce((n, o) => n + o.count, 0),
      tasks: off.flatMap((o) => o.tasks).join(", "),
    },
  };
}

const isConflict = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "conflict";

/** How many tasks hold each size, read again whenever the levels change or a change was sent. */
function useHeld(
  api: Api,
  levels: readonly EffortLevel[],
): [readonly EffortHeld[] | undefined, () => void] {
  const [held, setHeld] = useState<readonly EffortHeld[] | undefined>(undefined);
  const reads = useRef(0);
  const read = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    api.client.prefs.manage({ action: "get", keys: [KEY], mode: "apply" }).then(
      (answer) => {
        if (read === reads.current) setHeld(answer.prefs?.find((p) => p.key === KEY)?.held ?? []);
      },
      () => undefined,
    );
  }, [api]);
  useEffect(() => {
    read();
  }, [read, levels]);
  return [held, read];
}

export function EffortLevels({ headingClass }: { readonly headingClass: string }) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  const state = useLive();
  const { efforts: levels, effortsFixed: fixed } = state.scales;
  const [held, readHeld] = useHeld(api, levels);
  /** The level whose removal asks where its tasks go. */
  const [asking, setAsking] = useState<string | undefined>(undefined);
  /** A new level being named; `sent` once its name is on its way. */
  const [adding, setAdding] = useState<{ readonly sent?: string } | undefined>(undefined);
  const names = useRef(new Map<number, HTMLInputElement>());

  const focusName = (at: number) => {
    names.current.get(Math.max(0, at))?.focus();
  };

  /**
   * Saves `edit` against the levels on screen now, own changes on their way included. `inline`: a
   * text field says a refusal under itself; anything else says it in a toast.
   */
  const save = (edit: LevelEdit, inline: boolean): Promise<Outcome> => {
    const now = live.getState().scales.efforts;
    const write = levelsWrite(now, edit);
    if (write === undefined) return Promise.resolve("same");
    const keys = (list: readonly EffortLevel[]) => list.map((level) => level.key);
    const problem = checkEffortMoves(keys(now), keys(write.value), held ?? [], write.moves);
    if (problem !== undefined) {
      if (problem.holders !== undefined && edit.kind === "remove") {
        setAsking(now[edit.at]?.key);
        return Promise.resolve("asked");
      }
      if (!inline) say(problem.message);
      return Promise.resolve("failed");
    }
    return edits
      .write(
        (request, sent) =>
          api.client.prefs.manage({
            action: "set",
            set: [
              {
                key: KEY,
                value: write.value,
                ...(write.moves.length === 0 ? {} : { moves: write.moves }),
              },
            ],
            ...(sent === undefined ? {} : { base: sent }),
            request_id: request,
            mode: "apply",
          }),
        (result) => savedMsg(edit, now, result),
        { overlay: overlayOf(write, live.getState().tasks) },
      )
      .then(
        (): Outcome => {
          readHeld();
          return "saved";
        },
        (error: unknown): Outcome => {
          readHeld();
          if (live.failed(error)) return "failed";
          const outcome = isConflict(error) ? "conflict" : "failed";
          if (!inline) {
            say(
              outcome === "conflict"
                ? t("levels.changedToast")
                : refusalText(error, t("levels.failed")),
            );
          }
          return outcome;
        },
      );
  };

  const act = (edit: LevelEdit) => {
    void save(edit, false);
  };

  const move = (at: number, kind: "up" | "down") => {
    const to = at + (kind === "up" ? -1 : 1);
    if (to < 0 || to >= live.getState().scales.efforts.length) return;
    act({ kind, at });
    focusName(to);
  };

  const remove = (at: number, to?: string | null) => {
    const count = live.getState().scales.efforts.length;
    void save(to === undefined ? { kind: "remove", at } : { kind: "remove", at, to }, false);
    // Gone at once, as its overlay shows: the focus goes to the level that took its place.
    if (live.getState().scales.efforts.length < count) focusName(Math.min(at, count - 2));
  };

  const add = (name: string): Promise<Outcome> => {
    setAdding({ sent: name });
    return save({ kind: "add", name }, true).then((outcome) => {
      setAdding(outcome === "saved" || outcome === "same" ? undefined : {});
      return outcome;
    });
  };

  const draft =
    adding !== undefined &&
    !(adding.sent !== undefined && levels.some((l) => l.key === adding.sent));
  const rows: (EffortLevel | undefined)[] = draft ? [...levels, undefined] : [...levels];
  const readOnly = fixed !== undefined;

  return (
    <section className={styles.levels}>
      <Heading level={2} className={headingClass}>
        {t("levels.heading")}
      </Heading>
      <p className={styles.lead}>{t("levels.lead", { space: state.space?.name ?? "" })}</p>
      {fixed === undefined ? null : (
        <p className={styles.fixed} data-part="levels-fixed">
          {t(fixed === "newer" ? "levels.newer" : "levels.unreadable")}
        </p>
      )}
      <div className={styles.head} aria-hidden="true">
        <span>{t("levels.name")}</span>
        <span>{t("levels.time")}</span>
        <span>{t("levels.about")}</span>
      </div>
      <ol className={styles.list} aria-label={t("levels.list", { space: state.space?.name ?? "" })}>
        {rows.map((level, at) => (
          <LevelRow
            // By place, so a field keeps focus while the level in it moves or is renamed.
            key={at}
            at={at}
            level={level}
            levels={levels}
            held={held}
            readOnly={readOnly}
            asking={level !== undefined && level.key === asking}
            nameRef={(element) => {
              if (element === null) names.current.delete(at);
              else names.current.set(at, element);
            }}
            save={(edit) => save(edit, true)}
            act={act}
            add={add}
            drop={() => {
              setAdding(undefined);
            }}
            move={(kind) => {
              move(at, kind);
            }}
            remove={() => {
              remove(at);
            }}
            answer={(to) => {
              setAsking(undefined);
              if (to === undefined) focusName(at);
              else remove(at, to);
            }}
          />
        ))}
      </ol>
      {readOnly ? null : (
        <div className={styles.foot}>
          <Button
            className={styles.add}
            data-part="level-add"
            isDisabled={levels.length >= EFFORT_SCALE_MAX || adding !== undefined}
            onPress={() => {
              setAdding({});
            }}
          >
            <PlusIcon />
            {t("levels.add")}
          </Button>
          <span className={styles.count} data-part="level-count">
            {t("levels.count", { count: levels.length, max: EFFORT_SCALE_MAX })}
          </span>
        </div>
      )}
    </section>
  );
}

interface RowProps {
  readonly at: number;
  /** Undefined: a new level, not named yet. */
  readonly level: EffortLevel | undefined;
  readonly levels: readonly EffortLevel[];
  readonly held: readonly EffortHeld[] | undefined;
  readonly readOnly: boolean;
  readonly asking: boolean;
  readonly nameRef: (element: HTMLInputElement | null) => void;
  /** Saves a field's change: the field says a refusal. */
  readonly save: (edit: LevelEdit) => Promise<Outcome>;
  /** Saves any other change: a toast says a refusal. */
  readonly act: (edit: LevelEdit) => void;
  readonly add: (name: string) => Promise<Outcome>;
  readonly drop: () => void;
  readonly move: (kind: "up" | "down") => void;
  readonly remove: () => void;
  /** The move question's answer: where the tasks go, or undefined to keep the level. */
  readonly answer: (to: string | null | undefined) => void;
}

function LevelRow(props: RowProps) {
  const { at, level, levels, readOnly } = props;
  const t = useT();
  const n = at + 1;
  const name = level?.key ?? t("levels.newLevel");
  const [unit, setUnit] = useState<EffortUnit>(level?.time?.unit ?? "hours");
  const shownUnit = level?.time?.unit ?? unit;
  const count = level === undefined ? 0 : heldCount(heldBy(props.held ?? [], level.key));
  const first = at === 0;
  const last = at >= levels.length - 1;
  const only = levels.length <= 1;
  const fresh = level === undefined;

  return (
    <li className={styles.level} data-level={level?.key ?? ""}>
      <div className={`${styles.cell} ${styles.name}`}>
        <Cell
          part="level-name"
          label={t("levels.nameOf", { n })}
          value={level?.key ?? ""}
          maxLength={Math.max(EFFORT_NAME_MAX, level?.key.length ?? 0)}
          readOnly={readOnly}
          autoFocus={fresh}
          tip={level !== undefined && level.key.length > EFFORT_NAME_MAX ? level.key : undefined}
          inputRef={props.nameRef}
          problem={(text) => {
            const problem = nameProblem(levels, at, oneLine(text));
            return problem === undefined ? undefined : PROBLEMS[problem](t, oneLine(text));
          }}
          hint={(text) =>
            count > 0 && oneLine(text) !== level?.key ? t("levels.moveWith", { count }) : undefined
          }
          commit={(text) =>
            level === undefined
              ? props.add(oneLine(text))
              : props.save({ kind: "rename", at, name: oneLine(text) })
          }
          onKey={(event, settle) => {
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || fresh)
              return;
            event.preventDefault();
            event.stopPropagation();
            if (settle()) props.move(event.key === "ArrowUp" ? "up" : "down");
          }}
          {...(fresh ? { drop: props.drop } : {})}
        />
      </div>
      <div className={`${styles.cell} ${styles.time}`}>
        <Cell
          part="level-amount"
          label={t("levels.amountOf", { n })}
          value={level?.time === undefined ? "" : String(level.time.amount)}
          maxLength={3}
          numeric
          readOnly={readOnly}
          disabled={fresh}
          problem={(text) => (text !== "" && Number(text) < 1 ? t("levels.amount") : undefined)}
          commit={(text) =>
            props.save({
              kind: "time",
              at,
              time: text === "" ? undefined : { amount: Number(text), unit: shownUnit },
            })
          }
        />
        <select
          className={`${styles.select} ${styles.unit}`}
          data-part="level-unit"
          aria-label={t("levels.unitOf", { n })}
          value={shownUnit}
          disabled={readOnly || fresh}
          onChange={(event) => {
            const next = event.target.value as EffortUnit;
            setUnit(next);
            if (level?.time !== undefined) {
              props.act({ kind: "time", at, time: { amount: level.time.amount, unit: next } });
            }
          }}
        >
          {EFFORT_UNITS.map((u) => (
            <option key={u} value={u}>
              {t("levels.unit", { unit: u })}
            </option>
          ))}
        </select>
      </div>
      <div className={`${styles.cell} ${styles.about}`}>
        <Cell
          part="level-about"
          label={t("levels.aboutOf", { n })}
          value={level?.about ?? ""}
          maxLength={EFFORT_ABOUT_MAX}
          readOnly={readOnly}
          disabled={fresh}
          counter
          commit={(text) => {
            const about = oneLine(text);
            return props.save({ kind: "about", at, about: about === "" ? undefined : about });
          }}
        />
      </div>
      {readOnly || fresh ? null : (
        <div className={styles.actions}>
          <Button
            className={styles.act}
            data-part="level-up"
            aria-label={t("levels.up", { name })}
            data-tip={t("levels.up", { name })}
            isDisabled={first}
            onPress={() => {
              props.move("up");
            }}
          >
            <UpIcon />
          </Button>
          <Button
            className={styles.act}
            data-part="level-down"
            aria-label={t("levels.down", { name })}
            data-tip={t("levels.down", { name })}
            isDisabled={last}
            onPress={() => {
              props.move("down");
            }}
          >
            <DownIcon />
          </Button>
          <Button
            className={styles.act}
            data-part="level-remove"
            aria-label={t("levels.remove", { name })}
            data-tip={t("levels.remove", { name })}
            isDisabled={only}
            onPress={props.remove}
          >
            <CrossIcon />
          </Button>
          <MenuTrigger>
            <Button
              className={styles.more}
              data-part="level-more"
              aria-label={t("levels.more", { name })}
            >
              <MoreIcon />
            </Button>
            <Popover className={styles.menu} placement="bottom end" offset={4}>
              <Menu
                aria-label={t("levels.more", { name })}
                disabledKeys={[
                  ...(first ? ["up"] : []),
                  ...(last ? ["down"] : []),
                  ...(only ? ["remove"] : []),
                ]}
                onAction={(key) => {
                  if (key === "remove") props.remove();
                  else if (key === "up" || key === "down") props.move(key);
                }}
              >
                <MenuItem id="up" className={styles.item}>
                  {t("levels.up", { name })}
                </MenuItem>
                <MenuItem id="down" className={styles.item}>
                  {t("levels.down", { name })}
                </MenuItem>
                <MenuItem id="remove" className={styles.item}>
                  {t("levels.remove", { name })}
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </div>
      )}
      {props.asking && level !== undefined ? (
        <Question
          at={at}
          level={level}
          levels={levels}
          held={heldBy(props.held ?? [], level.key)}
          answer={props.answer}
        />
      ) : null}
    </li>
  );
}

/** Where the tasks of a removed level go: the next bigger level chosen, "No size" offered. */
function Question({
  at,
  level,
  levels,
  held,
  answer,
}: {
  readonly at: number;
  readonly level: EffortLevel;
  readonly levels: readonly EffortLevel[];
  readonly held: EffortHeld;
  readonly answer: (to: string | null | undefined) => void;
}) {
  const t = useT();
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [to, setTo] = useState(() => moveTarget(levels, at) ?? NO_SIZE);
  useEffect(() => {
    select.current?.focus();
  }, []);
  return (
    <div
      className={styles.ask}
      role="group"
      aria-labelledby={id}
      data-part="level-ask"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        answer(undefined);
      }}
    >
      <span id={id} className={styles.askLine}>
        {t("levels.ask", {
          count: heldCount(held),
          name: level.key,
          finished: held.finished,
          trash: held.trash,
        })}
      </span>
      <select
        ref={select}
        className={styles.select}
        data-part="level-ask-to"
        aria-label={t("levels.moveTo", { name: level.key })}
        value={to}
        onChange={(event) => {
          setTo(event.target.value);
        }}
      >
        {levels
          .filter((other) => other.key !== level.key)
          .map((other) => (
            <option key={other.key} value={other.key}>
              {other.key}
            </option>
          ))}
        <option value={NO_SIZE}>{t("levels.noSize")}</option>
      </select>
      <Button
        className={styles.act}
        data-part="level-ask-remove"
        onPress={() => {
          answer(to === NO_SIZE ? null : to);
        }}
      >
        {t("levels.remove", { name: level.key })}
      </Button>
      <Button
        className={styles.act}
        data-part="level-ask-keep"
        onPress={() => {
          answer(undefined);
        }}
      >
        {t("levels.keep")}
      </Button>
    </div>
  );
}

interface CellProps {
  readonly part: string;
  readonly label: string;
  /** What the level holds now. */
  readonly value: string;
  readonly maxLength: number;
  readonly readOnly: boolean;
  readonly disabled?: boolean;
  readonly numeric?: boolean;
  readonly autoFocus?: boolean;
  /** The whole value, for a name the field shows cut. */
  readonly tip?: string | undefined;
  readonly inputRef?: (element: HTMLInputElement | null) => void;
  /** What keeps the text from being saved. */
  readonly problem?: (text: string) => string | undefined;
  /** A line under a good text that differs from the value. */
  readonly hint?: (text: string) => string | undefined;
  /** Says how much room is left once the text is long. */
  readonly counter?: boolean;
  readonly commit: (text: string) => Promise<Outcome>;
  /** A key the field does not take itself. `settle` saves the text, false when it cannot. */
  readonly onKey?: (event: KeyboardEvent<HTMLInputElement>, settle: () => boolean) => void;
  /** A new level left without a name, or Escape in it: it goes. */
  readonly drop?: () => void;
}

/**
 * One field of a level. What the person types stays theirs until it is saved: the field shows the
 * level's value again only once the change was saved or Escape took it back. The change applies to
 * the levels as they are when it is saved, so a change someone made meanwhile stays too.
 */
function Cell(props: CellProps) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const text = draft ?? props.value;
  const problem = draft === undefined ? undefined : props.problem?.(draft);

  const settle = (): boolean => {
    if (draft === undefined) return true;
    if (problem !== undefined) return false;
    const sent = draft;
    void props.commit(sent).then((outcome) => {
      const kept = outcome === "conflict" || outcome === "failed";
      setFailed(kept);
      if (!kept) setDraft((now) => (now === sent ? undefined : now));
    });
    return true;
  };

  const line =
    problem ??
    (failed
      ? t("levels.notSaved")
      : draft === undefined || draft === props.value
        ? undefined
        : props.hint?.(draft)) ??
    (props.counter === true && text.length >= ABOUT_COUNT_FROM
      ? t("levels.count", { count: text.length, max: props.maxLength })
      : undefined);

  return (
    <>
      <input
        id={id}
        ref={props.inputRef}
        className={styles.input}
        data-part={props.part}
        aria-label={props.label}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={line === undefined ? undefined : `${id}-line`}
        data-tip={props.tip}
        value={text}
        maxLength={props.maxLength}
        readOnly={props.readOnly}
        disabled={props.disabled}
        inputMode={props.numeric === true ? "numeric" : undefined}
        // A new level's name is where the person goes to type it.
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const typed =
            props.numeric === true ? event.target.value.replace(/\D/gu, "") : event.target.value;
          setDraft(typed);
          setFailed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            settle();
          } else if (event.key === "Escape" && (draft !== undefined || props.drop !== undefined)) {
            event.preventDefault();
            event.stopPropagation();
            if (props.drop !== undefined) props.drop();
            setDraft(undefined);
            setFailed(false);
          } else {
            props.onKey?.(event, settle);
          }
        }}
        onBlur={() => {
          if (props.drop !== undefined && text.trim() === "") props.drop();
          else settle();
        }}
      />
      {line === undefined ? null : (
        <span
          id={`${id}-line`}
          className={problem !== undefined || failed ? styles.problem : styles.line}
          data-part={`${props.part}-line`}
        >
          {line}
        </span>
      )}
    </>
  );
}
