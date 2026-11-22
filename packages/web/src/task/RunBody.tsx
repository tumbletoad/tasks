// A background run's entry in the thread, below its actor line (Thread.tsx): what the person asked,
// the run's state in plain words with Stop while it may still work, then what the agent said. The
// answer and the question are the agent's text: Markdown that is never HTML, links made safe
// (markdown.tsx), a long one folded at ten lines until More. The state line is announced politely
// as it changes, so Stop's outcome is heard where Stop was pressed.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Run } from "../api.ts";
import { classes } from "../app/css.ts";
import { useT } from "../i18n/intl.tsx";
import { sayMsg } from "../row/say.ts";
import css from "./Expanded.module.css";
import { Markdown } from "./markdown.tsx";
import { runView } from "./runs.ts";

const styles = classes(css, [
  "asked",
  "askedBox",
  "runState",
  "runQuiet",
  "stop",
  "said",
  "question",
  "more",
  "error",
  "text",
]);

export interface RunBodyProps {
  readonly run: Run;
  /** The run's agent, as the thread names it. */
  readonly label: string;
  readonly onStop?: (run: Run) => void;
}

/** `text`, drawn by `children`, clamped at ten lines with More when it is longer. */
function Folded({
  text,
  className,
  part,
  children,
}: {
  readonly text: string;
  readonly className: string;
  readonly part: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || open) return;
    const measure = () => {
      setLong(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    // A narrower window wraps the same text onto more lines.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [text, open]);
  return (
    <div className={className}>
      <div ref={box} data-clamped={!open} data-part={part}>
        {children}
      </div>
      {long || open ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {t(open ? "task.less" : "task.more")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * What the person asked an agent: a run's words, or a launch's request (the note it names), drawn
 * the same in both entries of the thread. Null: the run works on the task. A long request folds,
 * so the state and its actions below it stay in reach.
 */
export function Asked({ words, part }: { readonly words: string | null; readonly part: string }) {
  const t = useT();
  return (
    <Folded text={words ?? ""} className={styles.askedBox} part={part}>
      <p className={styles.asked} dir="auto">
        {words === null ? t("run.askedTask") : t("run.asked", { words })}
      </p>
    </Folded>
  );
}

/** Renders again every half minute while `on`: a quiet run's minutes go on. */
function useTick(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [on]);
}

export function RunBody({ run, label, onStop }: RunBodyProps) {
  const t = useT();
  useTick(run.quiet_since !== undefined);
  const view = runView(run, label);
  const said = view.said;
  return (
    <div data-part="run" data-tone={view.tone}>
      <Asked words={run.asked} part="run-asked" />
      <p className={styles.runState} data-part="run-state" aria-live="polite">
        {view.status.map((m) => (
          <span key={m.id}>{sayMsg(t, m)}</span>
        ))}
        {view.stoppable && onStop !== undefined ? (
          <button
            type="button"
            className={styles.stop}
            data-part="run-stop"
            aria-label={t("run.stopLabel", { label })}
            onClick={() => {
              onStop(run);
            }}
          >
            {t("run.stop")}
          </button>
        ) : null}
      </p>
      {view.quiet === undefined ? null : (
        <p className={styles.runQuiet} data-part="run-quiet">
          {sayMsg(t, view.quiet)}
        </p>
      )}
      {view.error === undefined ? null : (
        <p className={styles.error} data-part="run-error" dir="auto">
          {view.error}
        </p>
      )}
      {said === undefined ? null : (
        <>
          {said.kind === "answer" ? null : (
            <p className={styles.asked}>
              {t(said.kind === "question" ? "run.question" : "run.lastSaid", { label })}
            </p>
          )}
          <Folded
            text={said.text}
            className={said.kind === "question" ? styles.question : styles.said}
            part="run-said"
          >
            <Markdown text={said.text} className={styles.text} />
          </Folded>
          {said.cut ? <p className={styles.asked}>{t("run.cut")}</p> : null}
        </>
      )}
    </div>
  );
}
