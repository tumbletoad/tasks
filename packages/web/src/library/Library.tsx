// A Library: what is known on the space, an area or a project, for the person to read and for
// every agent working below it. Its own brief, the person's text for agents and its description
// first, each with its pen; then its pages by title, the pages of its tasks, and, folded, what
// comes from the levels above. The lists are the live store's, so an agent's page arrives without
// a reload and one moved to the Trash leaves; the texts are read from the service, and read again
// when the feed says they changed. A project's and an area's Library is a tab beside their tasks,
// the space's an entry of the side menu.
import { Link } from "@tanstack/react-router";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useIntl } from "react-intl";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import { Markdown } from "../task/markdown.tsx";
import { TEXT_MAX } from "../unsent.ts";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { NodeView } from "./calls.ts";
import css from "./Library.module.css";
import { listsOf, type Level, type LibraryNode } from "./lists.ts";
import { BuildLibrary } from "./BuildLibrary.tsx";
import { NewPage } from "./NewPage.tsx";
import { PageList, Penned, useChanged, useFocusReturn } from "./parts.tsx";
import { useLibraryWrites } from "./writes.ts";

const styles = classes(css, [
  "library",
  "brief",
  "texts",
  "label",
  "value",
  "quiet",
  "penned",
  "clamped",
  "more",
  "section",
  "heading",
  "line",
  "fold",
  "level",
  "levelName",
  "tabs",
  "tab",
  "headed",
  "empty",
  "notice",
  "act",
  "place",
  "path",
  "count",
  "md",
]);

/** The description shows this many lines until the person asks for all of it. */
const DESCRIPTION_LINES = 12;
const BRIEF_MAX = 400;

/** A link is current only on its own address: the Tasks tab is not current under `/library`. */
const EXACT = { exact: true, includeSearch: false } as const;

/** The ID a node's words are kept under, and the target its reads and writes name. */
function idsOf(
  node: LibraryNode,
  space: string,
): { readonly key: string; readonly target: string } {
  return node.kind === "space"
    ? { key: space, target: "space" }
    : { key: node.id, target: node.id };
}

/** The Library's address of a node: the space's view, or an area's or a project's tab. */
export function LibraryLink({
  node,
  className,
  children,
}: {
  readonly node: LibraryNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const { space, projects } = useLive();
  const id = space?.id ?? "";
  // The router marks the link of the page on screen as current: this one only when it is exactly.
  const props = { className, activeOptions: EXACT };
  if (node.kind === "space") {
    return (
      <Link to="/s/$space/$view" params={{ space: id, view: "library" }} {...props}>
        {children}
      </Link>
    );
  }
  if (node.kind === "area") {
    return (
      <Link to="/s/$space/area/$area/library" params={{ space: id, area: node.id }} {...props}>
        {children}
      </Link>
    );
  }
  const area = projects.get(node.id)?.area_id;
  return area === undefined ? (
    <Link
      to="/s/$space/project/$project/library"
      params={{ space: id, project: node.id }}
      {...props}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/s/$space/area/$area/project/$project/library"
      params={{ space: id, area, project: node.id }}
      {...props}
    >
      {children}
    </Link>
  );
}

/** Tasks and Library, the two tabs of an area or a project, each with its count. */
export function NodeTabs({
  node,
  tab,
  tasks,
}: {
  readonly node: Exclude<LibraryNode, { kind: "space" }>;
  /** The tab on screen: the area in the path above leads to the same tab of the area. */
  readonly tab: "tasks" | "library";
  /** Its open tasks, as the side menu counts them. */
  readonly tasks: number | undefined;
}) {
  const t = useT();
  const intl = useIntl();
  const state = useLive();
  const pages = useMemo(() => {
    const lists = listsOf(node, state.pages.values(), "", state.areas, state.projects);
    return lists.own.length + lists.tasks.length;
  }, [node, state.pages, state.areas, state.projects]);
  const space = state.space?.id ?? "";
  const area = node.kind === "area" ? node.id : state.projects.get(node.id)?.area_id;
  const count = (n: number | undefined) =>
    n === undefined || n === 0 ? null : (
      <span className={styles.count} aria-hidden="true">
        {intl.formatNumber(n)}
      </span>
    );
  const tasksTab =
    node.kind === "area" ? (
      <Link
        to="/s/$space/area/$area"
        params={{ space, area: node.id }}
        className={styles.tab}
        activeOptions={EXACT}
      >
        {t("library.tasksTab")}
        {count(tasks)}
      </Link>
    ) : area === undefined ? (
      <Link
        to="/s/$space/project/$project"
        params={{ space, project: node.id }}
        className={styles.tab}
        activeOptions={EXACT}
      >
        {t("library.tasksTab")}
        {count(tasks)}
      </Link>
    ) : (
      <Link
        to="/s/$space/area/$area/project/$project"
        params={{ space, area, project: node.id }}
        className={styles.tab}
        activeOptions={EXACT}
      >
        {t("library.tasksTab")}
        {count(tasks)}
      </Link>
    );
  // Where the person is, above the tabs: the side menu is not in sight at a narrow width.
  const areaRow = area === undefined ? undefined : state.areas.get(area);
  const name =
    node.kind === "area" ? (areaRow?.title ?? "") : (state.projects.get(node.id)?.title ?? "");
  return (
    <div className={styles.place}>
      <p className={styles.path} data-part="node-path">
        {node.kind === "project" && areaRow !== undefined ? (
          tab === "library" ? (
            <LibraryLink node={{ kind: "area", id: areaRow.id }}>{areaRow.title}</LibraryLink>
          ) : (
            <Link to="/s/$space/area/$area" params={{ space, area: areaRow.id }}>
              {areaRow.title}
            </Link>
          )
        ) : null}
        <span dir="auto">{name}</span>
      </p>
      <nav className={styles.tabs} aria-label={t("library.tabs")} data-part="node-tabs">
        {tasksTab}
        <LibraryLink node={node} className={styles.tab}>
          {t("library.libraryTab")}
          {count(pages)}
        </LibraryLink>
      </nav>
    </div>
  );
}

/** The node's own texts, as the service last read them. */
function Texts({
  node,
  read,
  onDone,
}: {
  readonly node: LibraryNode;
  readonly read: NodeView;
  readonly onDone: () => void;
}) {
  const t = useT();
  const { space } = useLive();
  const writes = useLibraryWrites();
  const changed = useChanged();
  const editable = space?.read_only === undefined;
  const { key, target } = idsOf(node, space?.id ?? "");
  const base = read.as_of;
  const description = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const box = description.current;
    if (box === null || all) return;
    setLong(box.scrollHeight > box.clientHeight + 1);
  }, [read.description, all]);
  return (
    <>
      <Penned
        owner={key}
        part="brief"
        label={t("library.brief")}
        pen={t("library.briefEdit")}
        text={read.brief}
        base={base}
        max={BRIEF_MAX}
        line
        clears
        save={editable ? (words, from) => writes.node(target, { brief: words }, from) : undefined}
        onDone={onDone}
        view={(text, pen) => (
          <p className={styles.brief} data-part="node-brief">
            <span className={text === "" ? styles.quiet : undefined} dir="auto">
              {text === "" ? t("library.briefNone") : text}
            </span>
            {pen}
          </p>
        )}
      />
      <dl className={styles.texts}>
        <dt className={styles.label}>{t("library.forAgents")}</dt>
        <dd className={styles.value} data-part="for-agents">
          <Penned
            owner={key}
            part="for_agents"
            label={t("library.forAgents")}
            pen={t("library.forAgentsEdit")}
            text={read.for_agents?.text ?? ""}
            base={base}
            max={TEXT_MAX}
            clears
            save={editable ? (words, from) => writes.instruct(target, words, from) : undefined}
            onDone={onDone}
            view={(text, pen) => (
              <div className={styles.penned}>
                {text === "" ? (
                  <span className={styles.quiet}>{t("library.forAgentsNone")}</span>
                ) : (
                  <span>
                    <span dir="auto">{text}</span>
                    {read.for_agents === undefined ? null : (
                      <span className={styles.line}>
                        {changed("user", Date.parse(read.for_agents.at))}
                      </span>
                    )}
                  </span>
                )}
                {pen}
              </div>
            )}
          />
        </dd>
        <dt className={styles.label}>{t("library.description")}</dt>
        <dd className={styles.value} data-part="description">
          <Penned
            owner={key}
            part="description"
            label={t("library.description")}
            pen={t("library.descriptionEdit")}
            text={read.description}
            base={base}
            max={TEXT_MAX}
            paragraphs
            clears
            partial={read.slice === undefined ? undefined : t("text.partial")}
            save={
              editable
                ? (words, from) => writes.node(target, { description: words }, from)
                : undefined
            }
            onDone={onDone}
            view={(text, pen) => (
              <div className={styles.penned}>
                {text === "" ? (
                  <span className={styles.quiet}>{t("library.descriptionNone")}</span>
                ) : (
                  <div>
                    <div
                      ref={description}
                      className={all ? styles.md : `${styles.md} ${styles.clamped}`}
                      style={{ "--lines": DESCRIPTION_LINES } as CSSProperties}
                    >
                      <Markdown text={text} headings />
                    </div>
                    {long || all ? (
                      <button
                        type="button"
                        className={styles.more}
                        aria-expanded={all}
                        onClick={() => {
                          setAll(!all);
                        }}
                      >
                        {t(all ? "library.showLess" : "library.showAll")}
                      </button>
                    ) : null}
                  </div>
                )}
                {pen}
              </div>
            )}
          />
        </dd>
      </dl>
    </>
  );
}

/** What comes from above, folded: each level's name and count, and when open its pages. */
function Above({ levels, from }: { readonly levels: readonly Level[]; readonly from: string }) {
  const t = useT();
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  if (levels.length === 0) return null;
  const summary = intl.formatList(
    levels.map((level) =>
      t("library.levelCount", { title: level.title, count: level.pages.length }),
    ),
    { type: "unit", style: "short" },
  );
  return (
    <section className={styles.section} data-part="from-above">
      <h2 className={styles.heading}>
        <button
          type="button"
          className={styles.fold}
          data-holds={levels.flatMap((level) => level.pages.map((page) => page.ref)).join(" ")}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {t("library.above")}
          <span className={styles.line}>{summary}</span>
        </button>
      </h2>
      {open
        ? levels.map((level) => (
            <div
              key={level.node.kind === "space" ? "space" : level.node.id}
              className={styles.level}
            >
              <h3 className={styles.levelName}>
                <LibraryLink node={level.node}>{level.title}</LibraryLink>
              </h3>
              {level.pages.length === 0 ? (
                <p className={styles.quiet}>{t("library.empty")}</p>
              ) : (
                <PageList pages={level.pages} from={from} label={level.title} />
              )}
            </div>
          ))
        : null}
    </section>
  );
}

/** Parts of a long description read on with its cursor before the rest is left for another time. */
const MAX_PARTS = 20;

/** A node's texts, its description whole: a long one is read on with the answer's cursor. */
async function readNode(calls: Client, target: string): Promise<NodeView | undefined> {
  const first = await calls.page.read({ target });
  if (first.view !== "node") return undefined;
  let { description, slice, cursor } = first;
  const short = () => slice !== undefined && slice.to < slice.of && cursor !== undefined;
  for (let part = 0; short() && part < MAX_PARTS; part += 1) {
    const next = await calls.page.read({ target, ...(cursor === undefined ? {} : { cursor }) });
    if (next.view !== "node") break;
    description += next.description;
    ({ slice, cursor } = next);
  }
  const rest = { ...first, description };
  delete rest.slice;
  return slice !== undefined && slice.to < slice.of ? { ...rest, slice } : rest;
}

/** The texts a person reads in a Library: the same, or not. */
const sameTexts = (a: NodeView, b: NodeView): boolean =>
  a.brief === b.brief &&
  a.description === b.description &&
  a.for_agents?.text === b.for_agents?.text;

/** A Library: the node's texts, its pages, its tasks' pages, and what comes from above. */
export function NodeLibrary({ node }: { readonly node: LibraryNode }) {
  const t = useT();
  const { api, live } = useContext(Session);
  const state = useLive();
  const spaceId = state.space?.id ?? "";
  const { key, target } = idsOf(node, spaceId);
  const title =
    node.kind === "space"
      ? (state.space?.name ?? "")
      : ((node.kind === "area" ? state.areas.get(node.id) : state.projects.get(node.id))?.title ??
        "");
  const from = t("library.of", { name: title });
  const changed = useChanged();
  const root = useRef<HTMLDivElement>(null);
  useFocusReturn(root);
  const [read, setRead] = useState<NodeView | "failed" | undefined>(undefined);
  // Newer texts the feed brought while the person reads these: offered, never put in their place.
  const [newer, setNewer] = useState<NodeView | undefined>(undefined);
  const shown = useRef(read);
  shown.current = read;
  /** The next read follows the person's own pen: it takes the texts' place. */
  const own = useRef(false);
  const [round, setRound] = useState(0);
  // The texts change with no row in the feed: a change to them, or to the area's or project's own
  // row (its brief), reads them again.
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        if (reset || changes.some((change) => change.id === key && change.type !== "task")) {
          setRound((n) => n + 1);
        }
      }),
    [live, key],
  );
  useEffect(() => {
    let current = true;
    readNode(api.client, target).then(
      (answer) => {
        if (!current || answer === undefined) return;
        const now = shown.current;
        if (typeof now !== "object" || own.current || sameTexts(now, answer)) {
          setRead(answer);
          setNewer(undefined);
        } else setNewer(answer);
        own.current = false;
      },
      (error: unknown) => {
        if (current && !live.failed(error)) setRead("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [api, live, target, round]);
  const lists = useMemo(
    () => listsOf(node, state.pages.values(), state.space?.name ?? "", state.areas, state.projects),
    [node, state.pages, state.space?.name, state.areas, state.projects],
  );
  return (
    <div ref={root} className={styles.library} data-part="library">
      {read === "failed" ? (
        <p className={styles.quiet} role="status">
          {t("library.readFailed")}
          <button
            type="button"
            className={styles.more}
            onClick={() => {
              setRound((n) => n + 1);
            }}
          >
            {t("edit.tryAgain")}
          </button>
        </p>
      ) : read === undefined ? null : (
        <Texts
          node={node}
          read={read}
          onDone={() => {
            own.current = true;
            setRound((n) => n + 1);
          }}
        />
      )}
      {newer === undefined ? null : (
        // Under the texts, not above them: the words being read stay where they are.
        <p className={styles.notice} role="status" data-part="texts-newer">
          {newer.last === undefined
            ? t("library.textsChanged")
            : t("page.newer", { changed: changed(newer.last.by, Date.parse(newer.last.at)) })}
          <button
            type="button"
            className={styles.act}
            onClick={() => {
              setRead(newer);
              setNewer(undefined);
            }}
          >
            {t("page.showNewest")}
          </button>
        </p>
      )}
      <section className={styles.section} data-part="own-pages">
        <div className={styles.headed}>
          <h2 className={styles.heading}>{t("library.pages")}</h2>
          {state.space?.read_only === undefined ? <NewPage on={target} from={from} /> : null}
        </div>
        {lists.own.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.quiet}>{t("library.empty")}</p>
            {/* Nothing here yet, its tasks' pages included: an agent can build it from them. */}
            {node.kind !== "space" &&
            lists.tasks.length === 0 &&
            state.space?.read_only === undefined ? (
              <BuildLibrary node={node} />
            ) : null}
          </div>
        ) : (
          <PageList pages={lists.own} from={from} label={t("library.pages")} />
        )}
      </section>
      {lists.tasks.length === 0 ? null : (
        <section className={styles.section} data-part="task-pages">
          <h2 className={styles.heading}>{t("library.taskPages")}</h2>
          <PageList pages={lists.tasks} from={from} label={t("library.taskPages")} />
        </section>
      )}
      <Above levels={lists.above} from={from} />
    </div>
  );
}
