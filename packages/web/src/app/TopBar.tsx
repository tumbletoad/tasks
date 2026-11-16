// The top bar: one field that adds a task or searches, and a New task button. Refresh joins the
// bar with the refresh routine: a button that cannot start anything yet would only be noise.
//
// Adding is the field's own mode and the fast path: click it, type, Enter. The text's shortcuts
// (a date, p1 to p3, #area/project, @person, *) show under the field as what they became, each
// with a cross that keeps its words as text, and the title they leave. In an area's view the task
// lands in that area unless the person turns that off. Searching is a page state, the search
// route: `/` (outside a text field) or the lens at the field's start enter it, and the field then
// says so in its icon, its name and its placeholder, before anything is pressed. Typing there
// shows the results after a short quiet; Enter or the down arrow moves to the first result, never
// adds; Escape goes back to where the person was. Each mode keeps its own text: switching to
// search with an empty search takes the draft along as the search, and "add instead" takes the
// search along as the draft when there is none, so nothing typed is lost either way.
//
// The draft is kept per space, so it survives a switch to another space and back. A draft typed
// while an add was on its way stays. An add's text stays in the field until the feed confirms the
// add, so the field tracks it until then: the same text is not sent again while it is on its way,
// and when the space's session ends first (a switch of space stops its store, which then confirms
// nothing), an add the service took drops its text from the space's kept draft.
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-aria-components";
import {
  HERE_KEY,
  groupSuggestions,
  groupTyped,
  parseCapture,
  type Chip,
} from "../capture/parse.ts";
import { Session } from "../context.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { formatDay } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { onFieldRequest } from "./field.ts";
import { useToast } from "./frame.ts";
import { CrossIcon, PlusIcon, SearchIcon } from "./Icons.tsx";
import css from "./TopBar.module.css";
import { classes } from "./css.ts";
import { LANDING } from "./views.ts";

const styles = classes(css, [
  "bar",
  "button",
  "chip",
  "chips",
  "field",
  "hint",
  "input",
  "keep",
  "mode",
  "panel",
  "suggestion",
  "suggestions",
  "title",
]);

/** This tab's drafts of the field, per space. */
const drafts = new Map<string, string>();

/** How long the search waits for typing to pause before it reads. */
const QUIET_MS = 150;

/** Drops `text` from the space's kept draft, unless the draft has become something else. */
function forget(space: string, text: string): void {
  if (drafts.get(space) === text) drafts.delete(space);
}

/** Whether a key press belongs to a text field or an IME composition, where `/` is a character. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.isComposing) return true;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The first result's title, the one in the list's tab order. */
function focusFirstResult(): void {
  const title = document
    .getElementById("main")
    ?.querySelector<HTMLElement>('li[data-current="true"] [data-part="title"]');
  title?.focus();
}

/** What a chip shows: the value its words became. */
function chipLabel(t: Translate, chip: Chip, locale: string): string {
  switch (chip.kind) {
    case "due":
      return t("capture.due", {
        date: formatDay(chip.date, locale, { weekday: "short", day: "numeric", month: "short" }),
      });
    case "priority":
      return t("capture.priority", { level: chip.level });
    case "area":
      return chip.project === undefined
        ? t("capture.area", { area: chip.area.title })
        : t("capture.project", { area: chip.area.title, project: chip.project.title });
    case "waiting":
      return t("capture.waiting", { who: chip.who });
    case "star":
      return t("capture.star");
  }
}

export function TopBar({ space, live }: { readonly space: string; readonly live: boolean }) {
  const t = useT();
  const say = useToast();
  const { api, live: feed } = useContext(Session);
  const state = useLive();
  const clock = useClock(false);
  const navigate = useNavigate();
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const params: { area?: string; project?: string } = useParams({ strict: false });
  const searching = location.pathname === `/s/${space}/search`;
  const urlQuery = searching && typeof location.search.q === "string" ? location.search.q : "";

  const [text, setText] = useState(() => drafts.get(space) ?? "");
  const [query, setQuery] = useState(urlQuery);
  /** The keys of shortcuts the person kept as text, for as long as the draft lasts. */
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [caret, setCaret] = useState(0);
  /** Focus is in the field or its panel: the panel shows. */
  const [within, setWithin] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  /** Where the caret goes after the next render (a suggestion was taken). */
  const placeCaret = useRef<number | undefined>(undefined);
  /** The query this bar last wrote into the URL: the URL changing to it is no news. */
  const written = useRef(urlQuery);
  /** The route the person was on before searching, to go back to. */
  const back = useRef<string | undefined>(undefined);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The texts of adds on their way: sent, and not yet confirmed or refused. */
  const sending = useRef(new Set<string>());
  /** Of those, the ones the service took: they wait only for the feed. */
  const taken = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const took = taken.current;
    return () => {
      mounted.current = false;
      for (const text of took) forget(space, text);
    };
  }, [space]);

  useEffect(() => {
    if (text === "") drafts.delete(space);
    else drafts.set(space, text);
    if (text.trim() === "") setKept((known) => (known.size === 0 ? known : new Set()));
  }, [space, text]);

  // Back, Forward, a reload or a link changed the URL's query: the field follows it. Leaving the
  // search route by any way ends the search.
  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    clearTimeout(pending.current);
    setQuery(urlQuery);
  }, [urlQuery]);
  useEffect(() => {
    if (!searching) {
      clearTimeout(pending.current);
      written.current = "";
      setQuery("");
    }
  }, [searching]);
  useEffect(
    () => () => {
      clearTimeout(pending.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === undefined) return;
    placeCaret.current = undefined;
    field.current?.setSelectionRange(at, at);
    setCaret(at);
  });

  /** Writes the search into the URL, replacing the entry: typing is not a history of its own. */
  const writeQuery = (q: string) => {
    clearTimeout(pending.current);
    if (written.current === q) return;
    written.current = q;
    void navigate({
      to: "/s/$space/search",
      params: { space },
      search: q === "" ? {} : { q },
      replace: true,
    });
  };

  const startSearch = (initial: string) => {
    if (!searching) back.current = location.href;
    written.current = initial;
    setQuery(initial);
    void navigate({
      to: "/s/$space/search",
      params: { space },
      search: initial === "" ? {} : { q: initial },
    });
    field.current?.focus();
  };

  /** Back to where the person was before searching, in add mode with the draft. */
  const endSearch = (draft?: string) => {
    clearTimeout(pending.current);
    if (draft !== undefined && draft.trim() !== "") {
      setText((current) => (current.trim() === "" ? draft : current));
    }
    const to = back.current;
    back.current = undefined;
    if (to !== undefined && !to.startsWith(`/s/${space}/search`)) router.history.push(to);
    else void navigate({ to: "/s/$space/$view", params: { space, view: LANDING } });
    field.current?.focus();
  };

  const toggle = () => {
    if (searching) endSearch(query);
    else startSearch(query === "" ? text : query);
  };

  const request = useRef({ searching, endSearch });
  request.current = { searching, endSearch };
  useEffect(
    () =>
      onFieldRequest((asked) => {
        if (request.current.searching) request.current.endSearch(asked.text);
        else {
          setText((current) => (current.trim() === "" ? asked.text : current));
          field.current?.focus();
        }
      }),
    [],
  );

  // `/` outside a text field starts a search, or returns to the one on screen.
  const startSearchRef = useRef(startSearch);
  startSearchRef.current = startSearch;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || typing(event)) {
        return;
      }
      event.preventDefault();
      if (request.current.searching) field.current?.focus();
      else startSearchRef.current("");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const areas = useMemo(() => [...state.areas.values()], [state.areas]);
  const projects = useMemo(() => [...state.projects.values()], [state.projects]);
  const inArea = location.pathname.startsWith(`/s/${space}/area/`);
  const hereArea = inArea ? params.area : undefined;
  const hereProject = inArea ? params.project : undefined;
  const capture = useMemo(() => {
    const here =
      hereArea === undefined
        ? undefined
        : { area: hereArea, ...(hereProject === undefined ? {} : { project: hereProject }) };
    return parseCapture(text, { today: clock.today, areas, projects, here, kept });
  }, [text, clock.today, areas, projects, hereArea, hereProject, kept]);
  const typed = searching ? undefined : groupTyped(text, caret);
  const suggestions = typed === undefined ? [] : groupSuggestions(typed.typed, areas, projects);

  const take = (insert: string) => {
    if (typed === undefined) return;
    const rest = text.slice(typed.start + typed.typed.length).replace(/^\s*/u, "");
    const next = `${text.slice(0, typed.start)}${insert} ${rest}`;
    placeCaret.current = typed.start + insert.length + 1;
    setText(next);
    field.current?.focus();
  };

  const add = () => {
    const submitted = text;
    if (submitted.trim() === "") {
      field.current?.focus();
      return;
    }
    const draft = capture.draft;
    // Shortcuts alone: the panel says a title is missing.
    if (draft === undefined) return;
    if (!live || sending.current.has(submitted)) return;
    sending.current.add(submitted);
    const area = capture.chips.find((chip) => chip.kind === "area");
    const where =
      area === undefined
        ? draft.status === "waiting"
          ? t("nav.waiting")
          : t("capture.inbox")
        : chipLabel(t, area, clock.locale);
    // Through the live store: no optimistic row, and the text goes when the feed confirms the
    // add, so the new row is on screen when it does. Only the text that was added goes: whatever
    // the person typed meanwhile stays, here and in the space's kept draft.
    const sent = feed.write((request_id) => api.client.task.add({ tasks: [draft], request_id }));
    void sent.settled.then((settled) => {
      sending.current.delete(submitted);
      taken.current.delete(submitted);
      if (settled !== "confirmed") return;
      forget(space, submitted);
      if (mounted.current) say(t("top.added", { where }));
      setText((current) => (current === submitted ? "" : current));
    });
    sent.answer.then(
      () => {
        if (!sending.current.has(submitted)) return;
        if (mounted.current) taken.current.add(submitted);
        else forget(space, submitted);
      },
      (error: unknown) => {
        sending.current.delete(submitted);
        if (!feed.failed(error)) say(t("top.addFailed"));
      },
    );
  };

  const value = searching ? query : text;
  const label = searching ? t("top.search") : t("top.newTask");
  const showPanel =
    within &&
    !searching &&
    text.trim() !== "" &&
    (capture.chips.length > 0 || suggestions.length > 0);

  return (
    <div className={styles.bar}>
      <div
        ref={wrapper}
        className={styles.field}
        data-mode={searching ? "search" : "add"}
        onFocus={() => {
          setWithin(true);
        }}
        onBlur={(event) => {
          if (!wrapper.current?.contains(event.relatedTarget)) setWithin(false);
        }}
      >
        <Button
          className={styles.mode}
          aria-label={searching ? t("top.toAdd") : t("top.toSearch")}
          data-tip={searching ? t("top.toAdd") : t("top.toSearch")}
          isDisabled={!live}
          onPress={toggle}
        >
          {searching ? <SearchIcon /> : <PlusIcon />}
        </Button>
        <input
          ref={field}
          className={styles.input}
          type="text"
          value={value}
          maxLength={500}
          placeholder={searching ? t("top.searchPlaceholder") : t("top.newTask")}
          aria-label={label}
          aria-keyshortcuts="/"
          aria-describedby={showPanel ? "top-capture" : undefined}
          autoComplete="off"
          spellCheck={!searching}
          disabled={!live}
          onChange={(event) => {
            const next = event.target.value;
            setCaret(event.target.selectionStart ?? next.length);
            if (!searching) {
              setText(next);
              return;
            }
            setQuery(next);
            clearTimeout(pending.current);
            pending.current = setTimeout(() => {
              writeQuery(next.trim() === "" ? "" : next);
            }, QUIET_MS);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (searching) {
              if (event.key === "Escape") {
                event.preventDefault();
                endSearch();
              } else if (event.key === "Enter" || event.key === "ArrowDown") {
                event.preventDefault();
                writeQuery(query.trim() === "" ? "" : query);
                focusFirstResult();
              }
              return;
            }
            if (event.key === "Tab" && !event.shiftKey && suggestions[0] !== undefined) {
              event.preventDefault();
              take(suggestions[0].insert);
            } else if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        {searching ? null : (
          <kbd className={styles.hint} aria-hidden="true">
            {t("top.slash")}
          </kbd>
        )}
        {showPanel ? (
          <div className={styles.panel} id="top-capture">
            {suggestions.length === 0 ? null : (
              <div className={styles.suggestions} role="group" aria-label={t("top.suggestions")}>
                {suggestions.map((s) => (
                  <button
                    key={s.insert}
                    type="button"
                    className={styles.suggestion}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      take(s.insert);
                    }}
                  >
                    <span dir="auto">{s.insert}</span>
                  </button>
                ))}
              </div>
            )}
            {capture.chips.length === 0 ? null : (
              <ul className={styles.chips}>
                {capture.chips.map((chip) => {
                  const shown = chipLabel(t, chip, clock.locale);
                  return (
                    <li key={chip.key} className={styles.chip} data-kind={chip.kind}>
                      <span dir="auto">{shown}</span>
                      <button
                        type="button"
                        className={styles.keep}
                        aria-label={
                          chip.key === HERE_KEY
                            ? t("top.keepView", { where: shown })
                            : t("top.keepText", { text: chip.text })
                        }
                        data-tip={
                          chip.key === HERE_KEY
                            ? t("top.keepView", { where: shown })
                            : t("top.keepText", { text: chip.text })
                        }
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          setKept((known) => new Set([...known, chip.key]));
                          field.current?.focus();
                        }}
                      >
                        <CrossIcon />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {capture.chips.length === 0 ? null : (
              <p className={styles.title}>
                {capture.draft === undefined ? (
                  t("top.needsTitle")
                ) : (
                  <span dir="auto">{t("top.title", { title: capture.title })}</span>
                )}
              </p>
            )}
          </div>
        ) : null}
      </div>
      <Button
        className={styles.button}
        aria-label={searching ? t("top.toAdd") : t("top.add")}
        isDisabled={!live}
        onPress={() => {
          if (searching) endSearch(query);
          else add();
        }}
      >
        <PlusIcon />
      </Button>
    </div>
  );
}
