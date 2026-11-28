// The space's effort levels in Settings. Each change saves at once through `prefs.manage` with the
// moves that carry its tasks along and shows at once as an overlay; it is changed back by changing
// the levels again. The one question is where the tasks of a removed level go.
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button, Heading, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import type { Client } from "@ttasks/contracts/generated/client.ts";
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
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import type { TaskRow, Overlay, TaskOverlay } from "@ttasks/client/store";
import type { Msg } from "../row/model.ts";
import { useLive, useServes } from "../store/hooks.ts";
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
const AMOUNT = /^[0-9]{1,3}$/u;

type Outcome = "saved" | "same" | "asked" | "conflict" | "failed";
type SetAnswer = Awaited<ReturnType<Client["prefs"]["manage"]>>;

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

/** The toast of a saved change: what it did, and the tasks it moved or left off the levels. */
function savedMsg(edit: LevelEdit, result: SetAnswer | WriteReceipt): Msg {
  const answer = "receipt" in result ? undefined : result;
  const moved = (answer?.moved ?? []).reduce((n, m) => n + m.active + m.finished + m.trash, 0);
  const off = answer?.off_list ?? [];
  const was = edit.kind === "add" ? "" : edit.key;
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
  // A space that cannot change its preferences yet shows its levels to read.
  const served = useServes("prefs.manage");
  /** The level whose removal asks where its tasks go. */
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  /**
   * Each level's row by an identity that follows it through a rename and a move, so what is typed
   * in a field stays with its level and keeps the focus. A new level takes the row it was named in.
   */
  const ids = useRef(new Map<string, number>());
  const nextId = useRef(0);
  const addId = useRef(-1);
  const names = useRef(new Map<number, HTMLInputElement>());
  /** The row whose name takes the focus once the screen shows the change. */
  const focusTo = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (focusTo.current === undefined) return;
    names.current.get(focusTo.current)?.focus();
    focusTo.current = undefined;
  });

  const idOf = (key: string): number => {
    let id = ids.current.get(key);
    if (id === undefined) {
      id = nextId.current++;
      ids.current.set(key, id);
    }
    return id;
  };

  /** Saves `edit` against the levels on screen now. `inline`: a field says a refusal, else a toast. */
  const save = (edit: LevelEdit, inline: boolean): Promise<Outcome> => {
    const now = live.getState().scales.efforts;
    const write = levelsWrite(now, edit);
    if (write === undefined || live.getState().scales.effortsFixed !== undefined) {
      return Promise.resolve("same");
    }
    const keys = (list: readonly EffortLevel[]) => list.map((level) => level.key);
    const problem = checkEffortMoves(keys(now), keys(write.value), held ?? [], write.moves);
    if (problem !== undefined) {
      if (problem.holders !== undefined && edit.kind === "remove") {
        setAsking(edit.key);
        return Promise.resolve("asked");
      }
      if (!inline) say(problem.message);
      return Promise.resolve("failed");
    }
    if (edit.kind === "rename") ids.current.set(edit.name, idOf(edit.key));
    if (edit.kind === "add") ids.current.set(edit.name, addId.current);
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
        (result) => savedMsg(edit, result),
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

  const move = (key: string, kind: "up" | "down") => {
    focusTo.current = ids.current.get(key);
    act({ kind, key });
  };

  const remove = (key: string, to?: string | null) => {
    const now = live.getState().scales.efforts;
    const at = now.findIndex((level) => level.key === key);
    const next = now[at + 1]?.key ?? now[at - 1]?.key;
    act(to === undefined ? { kind: "remove", key } : { kind: "remove", key, to });
    // Gone at once when it was sent: the focus goes to the level that took its place.
    if (next !== undefined && !live.getState().scales.efforts.some((l) => l.key === key)) {
      focusTo.current = ids.current.get(next);
    }
  };

  const add = (name: string): Promise<Outcome> =>
    save({ kind: "add", name }, true).then((outcome) => {
      if (outcome === "saved") setAdding(false);
      return outcome;
    });

  const readOnly = fixed !== undefined || !served;
  const used = new Set<number>();
  const rows: { id: number; level: EffortLevel | undefined }[] = levels.map((level) => {
    let id = idOf(level.key);
    if (used.has(id)) {
      id = nextId.current++;
      ids.current.set(level.key, id);
    }
    used.add(id);
    return { id, level };
  });
  if (adding && !used.has(addId.current)) rows.push({ id: addId.current, level: undefined });

  return (
    <section className={styles.levels}>
      <Heading level={2} className={headingClass}>
        {t("levels.heading")}
      </Heading>
      <p className={styles.lead}>{t("levels.lead", { space: state.space?.name ?? "" })}</p>
      {fixed !== undefined ? (
        <p className={styles.fixed} data-part="levels-fixed">
          {t(fixed === "newer" ? "levels.newer" : "levels.unreadable")}
        </p>
      ) : served ? null : (
        <p className={styles.fixed} data-part="levels-fixed">
          {t("levels.notYet")}
        </p>
      )}
      <div className={styles.head} aria-hidden="true">
        <span>{t("levels.name")}</span>
        <span>{t("levels.time")}</span>
        <span>{t("levels.about")}</span>
      </div>
      <ol className={styles.list} aria-label={t("levels.list", { space: state.space?.name ?? "" })}>
        {rows.map(({ id, level }, at) => (
          <LevelRow
            key={id}
            at={at}
            level={level}
            levels={levels}
            held={held}
            readOnly={readOnly}
            asking={level !== undefined && level.key === asking}
            nameRef={(element) => {
              if (element === null) names.current.delete(id);
              else names.current.set(id, element);
            }}
            save={(edit) => save(edit, true)}
            act={act}
            add={add}
            drop={() => {
              setAdding(false);
            }}
            move={(kind, named) => {
              if (level !== undefined) move(named ?? level.key, kind);
            }}
            remove={() => {
              if (level !== undefined) remove(level.key);
            }}
            answer={(to) => {
              setAsking(undefined);
              if (level === undefined) return;
              if (to === undefined) focusTo.current = id;
              else remove(level.key, to);
            }}
          />
        ))}
      </ol>
      {readOnly ? null : (
        <div className={styles.foot}>
          <Button
            className={styles.add}
            data-part="level-add"
            isDisabled={levels.length >= EFFORT_SCALE_MAX || adding}
            onPress={() => {
              addId.current = nextId.current++;
              setAdding(true);
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
  /** A field's change: the field says a refusal. */
  readonly save: (edit: LevelEdit) => Promise<Outcome>;
  /** Any other change: a toast says a refusal. */
  readonly act: (edit: LevelEdit) => void;
  readonly add: (name: string) => Promise<Outcome>;
  readonly drop: () => void;
  /** `named`: what the level is called now, when a rename was just sent. */
  readonly move: (kind: "up" | "down", named?: string) => void;
  readonly remove: () => void;
  /** Where the tasks of a removed level go, or undefined to keep the level. */
  readonly answer: (to: string | null | undefined) => void;
}

function LevelRow(props: RowProps) {
  const { at, level, levels, readOnly } = props;
  const t = useT();
  const n = at + 1;
  const key = level?.key ?? "";
  const name = level?.key ?? t("levels.newLevel");
  const [unit, setUnit] = useState<EffortUnit>(level?.time?.unit ?? "hours");
  const shownUnit = level?.time?.unit ?? unit;
  const count = level === undefined ? 0 : heldCount(heldBy(props.held ?? [], key));
  const fresh = level === undefined;
  const actions: readonly {
    readonly id: "up" | "down" | "remove";
    readonly icon: ReactNode;
    readonly label: MessageId;
    readonly off: boolean;
    readonly run: () => void;
  }[] = [
    {
      id: "up",
      label: "levels.up",
      icon: <UpIcon />,
      off: at === 0,
      run: () => {
        props.move("up");
      },
    },
    {
      id: "down",
      label: "levels.down",
      icon: <DownIcon />,
      off: at >= levels.length - 1,
      run: () => {
        props.move("down");
      },
    },
    {
      id: "remove",
      label: "levels.remove",
      icon: <CrossIcon />,
      off: levels.length <= 1,
      run: props.remove,
    },
  ];

  return (
    <li className={styles.level} data-level={key}>
      <div className={`${styles.cell} ${styles.name}`}>
        <Cell
          part="level-name"
          label={t("levels.nameOf", { n })}
          value={key}
          maxLength={Math.max(EFFORT_NAME_MAX, key.length)}
          readOnly={readOnly}
          autoFocus={fresh}
          tip={key.length > EFFORT_NAME_MAX ? key : undefined}
          inputRef={props.nameRef}
          problem={(text) => {
            const problem = nameProblem(levels, level?.key, oneLine(text));
            return problem === undefined ? undefined : PROBLEMS[problem](t, oneLine(text));
          }}
          hint={(text) =>
            count > 0 && oneLine(text) !== key ? t("levels.moveWith", { count }) : undefined
          }
          commit={(text) =>
            fresh
              ? props.add(oneLine(text))
              : props.save({ kind: "rename", key, name: oneLine(text) })
          }
          onKey={(event, settle) => {
            const up = event.key === "ArrowUp";
            if (!event.altKey || (!up && event.key !== "ArrowDown") || fresh || readOnly) return;
            event.preventDefault();
            event.stopPropagation();
            if (settle()) props.move(up ? "up" : "down", oneLine(event.currentTarget.value));
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
          problem={(text) =>
            text !== "" && (!AMOUNT.test(text) || Number(text) < 1) ? t("levels.amount") : undefined
          }
          commit={(text) =>
            props.save({
              kind: "time",
              key,
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
              props.act({ kind: "time", key, time: { amount: level.time.amount, unit: next } });
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
            return props.save({ kind: "about", key, about: about === "" ? undefined : about });
          }}
        />
      </div>
      {readOnly || fresh ? null : (
        <div className={styles.actions}>
          {actions.map((action) => (
            <Button
              key={action.id}
              className={styles.act}
              data-part={`level-${action.id}`}
              aria-label={t(action.label, { name })}
              data-tip={t(action.label, { name })}
              isDisabled={action.off}
              onPress={action.run}
            >
              {action.icon}
            </Button>
          ))}
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
                disabledKeys={actions.filter((action) => action.off).map((action) => action.id)}
                onAction={(id) => {
                  actions.find((action) => action.id === id)?.run();
                }}
              >
                {actions.map((action) => (
                  <MenuItem key={action.id} id={action.id} className={styles.item}>
                    {t(action.label, { name })}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </MenuTrigger>
        </div>
      )}
      {props.asking && level !== undefined ? (
        <Question
          level={level}
          levels={levels}
          held={heldBy(props.held ?? [], key)}
          answer={props.answer}
        />
      ) : null}
    </li>
  );
}

function Question({
  level,
  levels,
  held,
  answer,
}: {
  readonly level: EffortLevel;
  readonly levels: readonly EffortLevel[];
  readonly held: EffortHeld;
  readonly answer: (to: string | null | undefined) => void;
}) {
  const t = useT();
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [to, setTo] = useState(() => moveTarget(levels, level.key) ?? NO_SIZE);
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
  readonly value: string;
  readonly maxLength: number;
  readonly readOnly: boolean;
  readonly disabled?: boolean;
  readonly numeric?: boolean;
  readonly autoFocus?: boolean;
  /** The whole value, for a name the field shows cut. */
  readonly tip?: string | undefined;
  readonly inputRef?: (element: HTMLInputElement | null) => void;
  readonly problem?: (text: string) => string | undefined;
  /** A line under a good text that differs from the value. */
  readonly hint?: (text: string) => string | undefined;
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
    // Saved already, as a shortcut's save is when the focus it moves leaves the field.
    if (draft === props.value) {
      setDraft(undefined);
      return true;
    }
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
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setDraft(event.target.value);
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
