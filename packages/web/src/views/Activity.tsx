// Activity: what agents and routines did in the space, one line per change, newest on top
// (activity.ts reads, shapes and words them). A line names its time, the agent by its app's name,
// and each thing the change touched as a link to it (a task in the Trash opens there) with what the
// change did to it; several things that the same happened to are a count that opens their list. A
// change the feed tells of brings its line without a reload. While the person reads (scrolled down,
// the pointer or focus on a line) a new line goes on above without moving the line they read; at
// the top with nothing held it comes into sight. Older lines load as the end comes near, and
// "Older" stays for the keyboard.
import { Link } from "@tanstack/react-router";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Instance } from "@ttasks/contracts/runs";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatWhen } from "@ttasks/client/today";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { agentName } from "./agent-name.ts";
import {
  ActivityLog,
  follow,
  sentenceOf,
  shapeOf,
  type ActivityLine,
  type Said,
  type Say,
  type Target,
} from "./activity.ts";
import css from "./Activity.module.css";
import listCss from "./TaskList.module.css";

const styles = classes(css, [
  "log",
  "line",
  "time",
  "what",
  "by",
  "task",
  "sep",
  "empty",
  "count",
  "each",
]);
const list = classes(listCss, ["line", "more", "announce"]);

/** How far below the screen the list's end starts the next read: one screen ahead. */
const AHEAD = "0px 0px 100% 0px";

const nameOf = (line: ActivityLine, instances: readonly Instance[], t: Translate): string =>
  agentName(line.by, instances) ?? t("thread.agent");

/** The separator between a line's parts: a dot to see (its style draws it), a pause to hear. */
function Sep() {
  const t = useT();
  return (
    <>
      <span className={styles.sep} aria-hidden="true" />
      <span className="visually-hidden">{t("activity.pause")}</span>
    </>
  );
}

/** A thing a line names, as a link to it: a task opens (in the Trash when it is there). */
function TargetLink({ target, space }: { readonly target: Target; readonly space: string }) {
  const t = useT();
  if (target.name === "") return <>{t("activity.unnamed")}</>;
  const link =
    target.kind === "task" && target.ref !== undefined ? (
      <Link
        to="/s/$space/task/$task"
        params={{ space, task: target.ref }}
        className={styles.task}
        dir="auto"
      >
        {target.name}
      </Link>
    ) : target.kind === "project" && target.trash !== true ? (
      <Link
        to="/s/$space/project/$project"
        params={{ space, project: target.id }}
        className={styles.task}
        dir="auto"
      >
        {target.name}
      </Link>
    ) : target.kind === "page" && target.ref !== undefined && target.trash !== true ? (
      <Link
        to="/s/$space/page/$ref"
        params={{ space, ref: target.ref }}
        className={styles.task}
        dir="auto"
      >
        {target.name}
      </Link>
    ) : target.kind === "area" && target.trash !== true ? (
      <Link
        to="/s/$space/project/$project"
        params={{ space, project: target.id }}
        className={styles.task}
        dir="auto"
      >
        {target.name}
      </Link>
    ) : (
      <span dir="auto">{target.name}</span>
    );
  return (
    <>
      {link}
      {target.trash === true ? ` ${t("activity.inTrash")}` : null}
    </>
  );
}

/** A thing and what happened to it: its link, then its words. */
function SaidOf({ said, space }: { readonly said: Said; readonly space: string }) {
  return (
    <>
      <TargetLink target={said.target} space={space} />
      <Sep />
      {said.words}
    </>
  );
}

function Line({
  line,
  space,
  say,
  instances,
}: {
  readonly line: ActivityLine;
  readonly space: string;
  readonly say: Say;
  readonly instances: readonly Instance[];
}) {
  const { t, clock } = say;
  const shape = shapeOf(line, say);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className={styles.line} data-seq={line.seq}>
      <time className={styles.time} dateTime={new Date(line.at).toISOString()}>
        {formatWhen(line.at, clock)}
      </time>
      <span className={styles.what}>
        <span className={styles.by}>{nameOf(line, instances, t)}</span>
        <Sep />
        {shape.kind === "none" ? shape.words : null}
        {shape.kind === "one" ? (
          <>
            <SaidOf said={shape.main} space={space} />
            {shape.also.map((also) => (
              <span key={`${also.target.kind}:${also.target.id}`}>
                {t("activity.pause")}
                {also.words}
                {t("activity.colon")}
                <TargetLink target={also.target} space={space} />
              </span>
            ))}
          </>
        ) : null}
        {shape.kind === "many" ? (
          <>
            <button
              type="button"
              className={styles.count}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => {
                setOpen((was) => !was);
              }}
            >
              {t("activity.many", { count: shape.count, of: shape.of })}
            </button>
            <Sep />
            {shape.words}
          </>
        ) : null}
      </span>
      {shape.kind === "many" && open ? (
        <ul className={styles.each} id={id}>
          {shape.each.map((each) => (
            <li key={`${each.target.kind}:${each.target.id}`}>
              <SaidOf said={each} space={space} />
            </li>
          ))}
          {shape.count > shape.each.length ? (
            <li>{t("activity.notShown", { count: shape.count - shape.each.length })}</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** The line at the top of the screen, and where it is: the place a reader keeps. */
function readPlace(root: HTMLElement | null): { seq: string; top: number } | undefined {
  for (const item of root?.querySelectorAll<HTMLElement>(":scope > [data-seq]") ?? []) {
    const box = item.getBoundingClientRect();
    if (box.bottom > 0) return { seq: item.dataset["seq"] ?? "", top: box.top };
  }
  return undefined;
}

export function ActivityPage() {
  const t = useT();
  const { api, live } = useContext(Session);
  const { space, instances } = useLive();
  const clock = useClock(false);
  const say = useMemo(() => ({ t, clock }), [t, clock]);
  const log = useMemo(() => new ActivityLog((input) => api.client.activity.list(input)), [api]);
  const state = useSyncExternalStore(log.subscribe, log.getState);

  useEffect(() => {
    void log.start();
  }, [log]);
  useEffect(() => follow(log, live), [live, log]);

  // The reader's place: before newer lines land, where the line at the top of the screen is; after,
  // the same line goes back there.
  const root = useRef<HTMLOListElement>(null);
  const pointer = useRef(false);
  const place = useRef<{ seq: string; top: number } | undefined>(undefined);
  const top = state.lines[0]?.seq;
  const shownTop = useRef(top);
  const [announcement, setAnnouncement] = useState("");
  if (top !== shownTop.current) {
    const reading =
      window.scrollY > 0 ||
      pointer.current ||
      (root.current?.contains(document.activeElement) ?? false);
    if (shownTop.current !== undefined && reading) place.current = readPlace(root.current);
    shownTop.current = top;
  }
  useLayoutEffect(() => {
    const kept = place.current;
    place.current = undefined;
    if (kept === undefined) return;
    const item = root.current?.querySelector(`[data-seq="${kept.seq}"]`);
    if (item === null || item === undefined) return;
    const moved = item.getBoundingClientRect().top - kept.top;
    if (Math.abs(moved) > 0.5) window.scrollBy(0, moved);
  }, [state.lines]);

  // A line that came is announced once, the newest of them.
  const announced = useRef<number | undefined>(undefined);
  useEffect(() => {
    const newest = state.lines[0];
    if (state.phase !== "ready" || newest === undefined) return;
    if (announced.current !== undefined && newest.seq > announced.current) {
      setAnnouncement(sentenceOf(newest, nameOf(newest, instances, say.t), say));
    }
    announced.current = newest.seq;
  }, [state.lines, state.phase, say, instances]);

  const more = useRef<HTMLButtonElement>(null);
  const [holding, setHolding] = useState(false);
  const next = state.phase === "ready" && state.more && !state.olderFailed;
  useEffect(() => {
    const button = more.current;
    if (!next || button === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void log.older();
      },
      { rootMargin: AHEAD },
    );
    observer.observe(button);
    return () => {
      observer.disconnect();
    };
  }, [next, state.lines, log]);

  if (space === undefined) return null;
  if (state.phase === "failed") {
    return (
      <p className={list.line} role="status">
        {t("activity.failed")}
        <button
          type="button"
          className={list.more}
          onClick={() => {
            void log.start();
          }}
        >
          {t("edit.tryAgain")}
        </button>
      </p>
    );
  }
  return (
    <>
      {state.phase === "ready" && state.lines.length === 0 ? (
        <p className={styles.empty}>{t("activity.empty")}</p>
      ) : (
        <ol
          ref={root}
          className={styles.log}
          aria-label={t("activity.label")}
          onPointerEnter={() => {
            pointer.current = true;
          }}
          onPointerLeave={() => {
            pointer.current = false;
          }}
        >
          {state.lines.map((line) => (
            <Line key={line.seq} line={line} space={space.id} say={say} instances={instances} />
          ))}
        </ol>
      )}
      {state.olderFailed ? (
        <p className={list.line} role="status">
          {t("activity.olderFailed")}
          <button
            type="button"
            className={list.more}
            onClick={() => {
              void log.older();
            }}
          >
            {t("edit.tryAgain")}
          </button>
        </p>
      ) : null}
      {/* Reaching the button reads on, so the last stretch can arrive while it holds focus: it
          stays, saying so, until focus leaves. */}
      {(state.more && !state.olderFailed) || holding ? (
        <button
          ref={more}
          type="button"
          className={list.more}
          aria-disabled={state.loadingOlder || !state.more || undefined}
          onFocus={() => {
            setHolding(true);
          }}
          onBlur={() => {
            setHolding(false);
          }}
          onClick={() => {
            void log.older();
          }}
        >
          {t(state.more ? "activity.older" : "activity.all")}
        </button>
      ) : null}
      <div className={list.announce} role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
