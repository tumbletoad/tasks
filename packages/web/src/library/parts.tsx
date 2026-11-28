// The pieces the Library and a page's screen share: who changed something and how long ago, a text
// the person corrects with the pen, and a list of pages to open.
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, type ReactNode, type RefObject } from "react";
import { useIntl, type IntlShape } from "react-intl";
import type { Instance } from "@ttasks/contracts/runs";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { PageRow } from "@ttasks/client/store";
import { NotSaved, Pen, TextEditor, useEditing, useSaved } from "../task/TextEditor.tsx";
import type { TextPart } from "../unsent.ts";
import { agentName } from "../views/agent-name.ts";
import css from "./Library.module.css";

const styles = classes(css, ["rows", "row", "ref", "title", "brief", "meta"]);

/** Who: "you", the import, or the agent's app by name. */
export function whoOf(by: string, instances: readonly Instance[], t: Translate): string {
  if (by === "user") return t("library.you");
  if (by === "import") return t("library.import");
  return agentName(by, instances) ?? t("library.agent");
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 days ago", "yesterday", "now": how long ago `at` was, in the largest whole unit. */
export function ago(at: number, now: number, intl: IntlShape): string {
  const past = Math.max(0, now - at);
  for (const [unit, ms] of UNITS) {
    if (past >= ms)
      return intl.formatRelativeTime(-Math.floor(past / ms), unit, { numeric: "auto" });
  }
  return intl.formatRelativeTime(0, "second", { numeric: "auto" });
}

/** "Codex · 2 days ago": who changed something last, and when, read on the page's clock. */
export function useChanged(): (by: string, at: number) => string {
  const t = useT();
  const intl = useIntl();
  const clock = useClock(true);
  const { instances } = useLive();
  return (by, at) =>
    t("library.when", { who: whoOf(by, instances, t), when: ago(at, clock.now, intl) });
}

/**
 * A text the person corrects with the pen where it stands: shown by `view` with its pen, or, while
 * open, as the box. The words are kept under `owner` (a page's or a node's ID) and `part`, as a
 * task's are under its own, and a refused save waits under the text as not saved.
 */
export function Penned({
  owner,
  part,
  label,
  pen,
  text,
  base,
  max,
  line = false,
  paragraphs = false,
  clears = false,
  preview,
  partial,
  save,
  onDone,
  opening = false,
  view,
}: {
  readonly owner: string;
  readonly part: TextPart;
  /** The box's name. */
  readonly label: string;
  /** The pen's name. */
  readonly pen: string;
  readonly text: string;
  readonly base: string | undefined;
  readonly max: number;
  readonly line?: boolean;
  readonly paragraphs?: boolean;
  readonly clears?: boolean;
  /** The words as the text shows them, for the box's Preview. */
  readonly preview?: (typed: string) => ReactNode;
  /** Why the pen opens nothing here: only part of the text is loaded. */
  readonly partial?: string | undefined;
  /** Undefined: the text is not corrected from here. */
  readonly save: ((words: string, base: string | undefined) => Promise<unknown>) | undefined;
  readonly onDone?: () => void;
  /** The box opens as the text comes in sight: a page the person just made, to write in. */
  readonly opening?: boolean;
  readonly view: (text: string, pen: ReactNode) => ReactNode;
}) {
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  const [editing, setEditing] = useEditing(
    space,
    owner,
    part,
    text,
    save !== undefined && partial === undefined,
  );
  useEffect(() => {
    if (opening) setEditing(true);
  }, [opening, setEditing]);
  const [shown, saved] = useSaved(text);
  // Words a save left waiting stay reachable, with Copy and Discard, also once the pen is gone.
  const notSaved = <NotSaved space={space} owner={owner} part={part} />;
  if (editing && save !== undefined) {
    return (
      <>
        <TextEditor
          space={space}
          owner={owner}
          part={part}
          label={label}
          text={shown}
          line={line}
          paragraphs={paragraphs}
          clears={clears}
          preview={preview}
          max={max}
          base={base}
          save={save}
          onDone={(words) => {
            saved(words);
            setEditing(false);
            onDone?.();
          }}
          reopen={() => {
            setEditing(true);
          }}
        />
        {notSaved}
      </>
    );
  }
  return (
    <>
      {view(
        shown,
        save === undefined ? null : (
          <Pen
            label={pen}
            why={partial}
            onPress={() => {
              setEditing(true);
            }}
          />
        ),
      )}
      {notSaved}
    </>
  );
}

/**
 * Where the person is as they open a page, for its way back: the address, `?task=` included, and
 * its name. Read when the link is followed, so it is the address of that moment.
 */
export function fromHere(label: string): { readonly path: string; readonly label: string } {
  return { path: `${location.pathname}${location.search}`, label };
}

/** The page link the person followed last, and the address it was on: Back focuses it again. */
let followed: { readonly path: string; readonly ref: string } | undefined;

/** Notes the page link the person follows, for the way back. */
export function noteFollowed(ref: string): void {
  followed = { path: `${location.pathname}${location.search}`, ref };
}

/**
 * Back on the address a page was opened from: focus goes to the link the person followed, or to
 * the fold that holds it when that is closed (`data-holds`), within `root`.
 */
export function useFocusReturn(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const last = followed;
    if (last === undefined || last.path !== `${location.pathname}${location.search}`) return;
    const within = root.current;
    const target =
      within?.querySelector<HTMLElement>(`[data-ref="${last.ref}"]`) ??
      [...(within?.querySelectorAll<HTMLElement>("[data-holds]") ?? [])].find((fold) =>
        (fold.dataset["holds"] ?? "").split(" ").includes(last.ref),
      );
    // Another part of the screen may hold the link (Today has the card and its own list).
    if (target === undefined) return;
    followed = undefined;
    target.focus();
  }, [root]);
}

/**
 * Pages to open, each one line wide (two at a narrow width): its reference, title and brief, and
 * who changed it last and when; a task's page names its task first.
 */
export function PageList({
  pages,
  from,
  label,
}: {
  readonly pages: readonly PageRow[];
  /** The name of where the person is: the page's way back. */
  readonly from: string;
  /** The list's name. */
  readonly label: string;
}) {
  const t = useT();
  const changed = useChanged();
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  return (
    <ul className={styles.rows} aria-label={label}>
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/s/$space/page/$ref"
            params={{ space, ref: page.ref }}
            state={() => ({ from: fromHere(from) })}
            className={styles.row}
            data-part="page-row"
            data-ref={page.ref}
            onClick={() => {
              noteFollowed(page.ref);
            }}
          >
            <span className={styles.ref}>{page.ref}</span>
            <span className={styles.title} dir="auto">
              {page.title}
            </span>
            {page.brief === "" ? null : (
              <span className={styles.brief} dir="auto">
                {page.brief}
              </span>
            )}
            <span className={styles.meta}>
              {page.task === undefined
                ? changed(page.by, page.at)
                : t("library.onTask", { task: page.task.ref, changed: changed(page.by, page.at) })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
