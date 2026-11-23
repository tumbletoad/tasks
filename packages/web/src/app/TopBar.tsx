// The top bar: one field that adds a task or searches, and a New task button. Refresh joins the
// bar with the refresh routine: a button that cannot start anything yet would only be noise.
//
// Adding is the field's own mode and the fast path: click it, type, Enter. The text's shortcuts
// (a date, p1 to p3, #area/project, @person, *) show under the field as what they became, each
// with a cross that keeps its words as text, and the title they leave. In an area's view the task
// lands in that area unless the person turns that off. An archived area or project takes no new
// task here: `#` does not offer it, a `#name` of one says it is archived and leaves its words in
// the title (an area's name never falls through to a live project of that name), and an archived
// area's own view adds to no area. `n` (outside a text field) comes here to add.
// Searching is a page state, the search route: `/` (outside a text field), Ctrl+K or the lens at
// the field's start enter it, and the field then
// says so in its icon, its name and its placeholder, before anything is pressed. Typing there
// shows the results after a short quiet; Enter or the down arrow moves to the first result, never
// adds; Escape goes back to where the person was. Each mode keeps its own text: switching to
// search with an empty search takes the draft along as the search, and "add instead" takes the
// search along as the draft when there is none, so nothing typed is lost either way.
//
// The draft is kept per space for the tab (kept.ts), so it survives a switch to another space and
// back, and a reload; another tab keeps its own. A draft typed while an add was on its way stays. An add's text stays in
// the field until the feed confirms the add, so the field tracks it until then: the same text is
// not sent again while it is on its way, and when the space's session ends first (a switch of
// space stops its store, which then confirms nothing), an add the service took drops its text from
// the space's kept draft.
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
import { requestId } from "../api.ts";
import { Session } from "../context.ts";
import { liveGroups } from "../groups.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import { tabKept } from "../kept.ts";
import { readOnlyReason, readOnlyWhy } from "../edit/read-only.ts";
import { formatDay } from "../row/dates.ts";
import { CopyIcon } from "../row/icons.tsx";
import { sayMsg } from "../row/say.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { actionOf, ariaKeys, isMac, keysOf } from "../keys/keymap.ts";
import { useKeyLabel } from "../keys/labels.ts";
import { onFieldRequest, wantResults } from "./field.ts";
import { useToast } from "./frame.ts";
import { useMachine } from "./machine.ts";
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

/** The field's limit: more than any title, so the shortcuts have room. */
const FIELD_MAX = 500;

/**
 * The field's draft of a space, with the shortcuts the person kept as text: without them a word
 * turned back into text would become a shortcut again after a switch of space or a reload.
 */
interface Draft {
  readonly text: string;
  readonly kept: ReadonlySet<string>;
  /**
   * The request ID of the add of this text that got no answer: the same add again, also after a
   * reload, carries it, so the service gives back the task it made instead of a second.
   */
  readonly request?: string;
}

const REQUEST_ID = /^[0-9a-f-]{36}$/u;

const draftName = (space: string) => `top.${space}`;

function readTop(space: string): Draft | undefined {
  return draftOf(tabKept.json(draftName(space)));
}

/** A kept draft, read by its shape. */
function draftOf(value: unknown): Draft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { text, kept, request } = value as { text?: unknown; kept?: unknown; request?: unknown };
  if (typeof text !== "string" || text === "" || text.length > FIELD_MAX) return undefined;
  const keys = Array.isArray(kept)
    ? kept.filter((k): k is string => typeof k === "string" && k.length <= 100).slice(0, 50)
    : [];
  return {
    text,
    kept: new Set(keys),
    ...(typeof request === "string" && REQUEST_ID.test(request) ? { request } : {}),
  };
}

/** Keeps the draft; the same text keeps the request ID of its unanswered add. */
function keepTop(space: string, draft: Draft | undefined): void {
  const before = readTop(space);
  const request = draft?.request ?? (before?.text === draft?.text ? before?.request : undefined);
  const value =
    draft === undefined || draft.text === ""
      ? undefined
      : JSON.stringify({
          text: draft.text,
          kept: [...draft.kept],
          ...(request === undefined ? {} : { request }),
        });
  if (tabKept.read(draftName(space)) !== value) tabKept.keep(draftName(space), value);
}

/** The request ID for an add of `text`: its unanswered one's, else a new one, kept with it. */
function requestFor(space: string, text: string, kept: ReadonlySet<string>): string {
  const before = readTop(space);
  if (before?.text === text && before.request !== undefined) return before.request;
  const request = requestId();
  keepTop(space, { text, kept, request });
  return request;
}

/** The add of `text` was refused: it did nothing, so the next one is a new request. */
function dropRequest(space: string, text: string): void {
  const before = readTop(space);
  if (before?.text !== text || before.request === undefined) return;
  tabKept.keep(draftName(space), JSON.stringify({ text, kept: [...before.kept] }));
}

/** How long the search waits for typing to pause before it reads. */
const QUIET_MS = 150;

/** Drops `text` from the space's kept draft, unless the draft has become something else. */
function forget(space: string, text: string): void {
  if (readTop(space)?.text === text) keepTop(space, undefined);
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

/**
 * `live`: the field adds and searches. `ended`: the tab's copy of its space is gone, so nothing
 * more is saved from it: the field keeps what was typed, to select or Copy, and sends nothing.
 */
export function TopBar({
  space,
  live,
  ended = false,
}: {
  readonly space: string;
  readonly live: boolean;
  readonly ended?: boolean;
}) {
  const t = useT();
  const say = useToast();
  const { api, live: feed } = useContext(Session);
  const state = useLive();
  const clock = useClock(false);
  const navigate = useNavigate();
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const params: { area?: string; project?: string } = useParams({ strict: false });
  const { singleKeys } = useMachine();
  const mac = useMemo(isMac, []);
  const keyLabel = useKeyLabel();
  /** The key that searches, shown in the field: `/`, or Ctrl K while single keys are off. */
  const hint = keysOf("search", singleKeys)[0];
  const searching = location.pathname === `/s/${space}/search`;
  const urlQuery = searching && typeof location.search.q === "string" ? location.search.q : "";

  const [text, setText] = useState(() => readTop(space)?.text ?? "");
  const [query, setQuery] = useState(urlQuery);
  /** The keys of shortcuts the person kept as text, for as long as the draft lasts. */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => readTop(space)?.kept ?? new Set());
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
    keepTop(space, text === "" ? undefined : { text, kept });
    if (text.trim() === "") setKept((known) => (known.size === 0 ? known : new Set()));
  }, [space, text, kept]);

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
      wantResults(undefined);
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
    wantResults(undefined);
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

  const request = useRef({ searching, endSearch, startSearch });
  request.current = { searching, endSearch, startSearch };
  useEffect(
    () =>
      onFieldRequest((asked) => {
        const now = request.current;
        if (asked.kind === "search") {
          // A search starts, or the one on screen gets the field back.
          if (now.searching) field.current?.focus();
          else now.startSearch("");
        } else if (now.searching) {
          now.endSearch(asked.kind === "add" ? asked.text : undefined);
        } else {
          if (asked.kind === "add") {
            setText((current) => (current.trim() === "" ? asked.text : current));
          }
          field.current?.focus();
        }
      }),
    [],
  );

  // New work goes to live groups only: an archived one is neither suggested nor taken, and its name
  // is said to be archived rather than read as another group's.
  const { areas, projects, archived } = useMemo(() => {
    const open = liveGroups(state.areas.values(), state.projects.values());
    const liveIds = new Set([...open.areas, ...open.projects].map((g) => g.id));
    return {
      ...open,
      archived: {
        areas: [...state.areas.values()].filter((a) => !liveIds.has(a.id)),
        projects: [...state.projects.values()].filter((p) => !liveIds.has(p.id)),
      },
    };
  }, [state.areas, state.projects]);
  // Only an area's and a project's routes have these. On a project's page a capture goes where the
  // project is now, whatever area its address names.
  const hereProject = params.project;
  const hereArea =
    hereProject === undefined ? params.area : state.projects.get(hereProject)?.area_id;
  const capture = useMemo(() => {
    const here =
      hereArea === undefined
        ? undefined
        : { area: hereArea, ...(hereProject === undefined ? {} : { project: hereProject }) };
    return parseCapture(text, { today: clock.today, areas, projects, archived, here, kept });
  }, [text, clock.today, areas, projects, archived, hereArea, hereProject, kept]);
  // On a group's page a capture usually lands in that group: one that goes to the Inbox instead (a
  // project without an area, an archived group, the page's chip taken off) says so.
  const toInbox =
    (params.area !== undefined || params.project !== undefined) &&
    capture.archived === undefined &&
    !capture.chips.some((chip) => chip.kind === "area" || chip.kind === "waiting");
  // What the text's shortcuts became, an archived group a `#name` named instead, or the Inbox.
  const read = capture.chips.length > 0 || capture.archived !== undefined || toInbox;
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
    const sent = feed.write(
      (request_id) => api.client.task.add({ tasks: [draft], request_id }),
      undefined,
      requestFor(space, submitted, kept),
    );
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
        // A refusal the service sent did nothing: the same text again is a new add.
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        if (typeof code === "string" && code !== "internal") dropRequest(space, submitted);
        if (feed.failed(error)) return;
        // The words stay in the field: a space that takes no change says why, without "Try again".
        const readOnly = readOnlyReason(error);
        say(
          readOnly === undefined
            ? t("top.addFailed")
            : t("top.addReadOnly", { why: sayMsg(t, readOnlyWhy(readOnly)) }),
        );
      },
    );
  };

  const value = searching ? query : text;
  const label = searching ? t("top.search") : t("top.newTask");
  const showPanel =
    within && !ended && !searching && text.trim() !== "" && (read || suggestions.length > 0);

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
          maxLength={FIELD_MAX}
          placeholder={searching ? t("top.searchPlaceholder") : t("top.newTask")}
          aria-label={label}
          aria-keyshortcuts={ariaKeys(keysOf("search", singleKeys), mac)}
          aria-describedby={showPanel ? "top-capture" : undefined}
          autoComplete="off"
          spellCheck={!searching}
          disabled={!live && !ended}
          readOnly={ended}
          onChange={(event) => {
            const next = event.target.value;
            setCaret(event.target.selectionStart ?? next.length);
            if (!searching) {
              setText(next);
              return;
            }
            setQuery(next);
            wantResults(undefined);
            clearTimeout(pending.current);
            pending.current = setTimeout(() => {
              writeQuery(next.trim() === "" ? "" : next);
            }, QUIET_MS);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0);
          }}
          onPaste={(event) => {
            // The field takes what fits and drops the rest: say so, the clipboard still has it.
            const pasted = event.clipboardData.getData("text/plain").length;
            const input = event.currentTarget;
            const chosen = (input.selectionEnd ?? 0) - (input.selectionStart ?? 0);
            if (input.value.length - chosen + pasted > FIELD_MAX) {
              say(t("top.pasteCut", { count: FIELD_MAX }));
            }
          }}
          onKeyDown={(event) => {
            const action = actionOf(event.nativeEvent, "field", singleKeys);
            const close = actionOf(event.nativeEvent, "page", singleKeys) === "close";
            if (searching) {
              if (close) {
                event.preventDefault();
                endSearch();
              } else if (action === "add" || action === "results") {
                event.preventDefault();
                const q = query.trim();
                writeQuery(q === "" ? "" : query);
                // The results take focus once this search's rows are on screen.
                wantResults(q === "" ? undefined : q);
              }
              return;
            }
            if (action === "suggestion" && suggestions[0] !== undefined) {
              event.preventDefault();
              take(suggestions[0].insert);
            } else if (action === "add") {
              event.preventDefault();
              add();
            }
          }}
        />
        {searching || hint === undefined ? null : (
          <kbd className={styles.hint} aria-hidden="true">
            {keyLabel(hint)}
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
            {!read ? null : (
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
                {toInbox ? (
                  <li className={styles.chip} data-kind="inbox">
                    <span>{t("capture.inbox")}</span>
                  </li>
                ) : null}
                {capture.archived === undefined ? null : (
                  <li className={styles.chip} data-kind="archived">
                    <span dir="auto">{t("capture.archived", { name: capture.archived })}</span>
                  </li>
                )}
              </ul>
            )}
            {!read ? null : (
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
      {ended && !searching && text.trim() !== "" ? (
        <Button
          className={styles.button}
          data-part="top-copy"
          aria-label={t("top.copy")}
          data-tip={t("top.copy")}
          onPress={() => {
            navigator.clipboard.writeText(text).then(
              () => {
                say(t("row.copied"));
              },
              () => {
                say(t("row.copyFailed"));
              },
            );
          }}
        >
          <CopyIcon />
        </Button>
      ) : (
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
      )}
    </div>
  );
}
