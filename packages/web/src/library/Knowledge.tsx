// A task card's Knowledge: the task's own pages, "+ page" for a new one on it, and, folded, what is
// known above it (its project, its area, the space), each level's pages under its name. From the
// live store's pages, so it stands with the card's first frame and never arrives later to push
// what is drawn; a page an agent writes meanwhile joins it. A page opened from here goes back to
// the same list with the task expanded: the way back is this address, `?task=` included.
import { Link } from "@tanstack/react-router";
import { useContext, useMemo, useState } from "react";
import { classes } from "../app/css.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import type { PageRow, TaskRow } from "../store/rows.ts";
import css from "./Library.module.css";
import { LibraryLink } from "./Library.tsx";
import { taskLists } from "./lists.ts";
import { NewPage } from "./NewPage.tsx";
import { fromHere } from "./parts.tsx";

const styles = classes(css, [
  "knowledge",
  "kLabel",
  "kValue",
  "kPages",
  "kPage",
  "ref",
  "fold",
  "kLevel",
  "kLevelName",
]);

function Pages({
  pages,
  from,
}: {
  readonly pages: readonly PageRow[];
  /** The name of where the person is: the page's way back. */
  readonly from: string;
}) {
  const { live } = useContext(Session);
  const space = live.spaceId ?? "";
  return (
    <ul className={styles.kPages}>
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/s/$space/page/$ref"
            params={{ space, ref: page.ref }}
            state={() => ({ from: fromHere(from) })}
            className={styles.kPage}
            data-part="knowledge-page"
            {...(page.brief === "" ? {} : { "data-tip": page.brief })}
          >
            <span className={styles.ref}>{page.ref}</span>
            <span dir="auto">{page.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Knowledge({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const state = useLive();
  const [open, setOpen] = useState(false);
  const from = t("library.task", { ref: task.ref, title: task.title });
  const { own, above } = useMemo(
    () =>
      taskLists(task, state.pages.values(), state.space?.name ?? "", state.areas, state.projects),
    [task, state.pages, state.space?.name, state.areas, state.projects],
  );
  const count = above.reduce((n, level) => n + level.pages.length, 0);
  // A new page goes on an open task that is not in the Trash, as any change to it.
  const writable =
    task.lifecycle === "active" &&
    task.deleted_at === undefined &&
    state.space?.read_only === undefined;
  return (
    <div
      className={styles.knowledge}
      data-part="knowledge"
      role="group"
      aria-label={t("library.knowledge")}
    >
      <span className={styles.kLabel}>{t("library.knowledge")}</span>
      <div className={styles.kValue}>
        {own.length === 0 ? null : <Pages pages={own} from={from} />}
        {writable ? <NewPage on={task.ref} from={from} label={t("library.addPage")} /> : null}
        {count === 0 ? null : (
          <>
            <button
              type="button"
              className={styles.fold}
              data-part="knowledge-above"
              aria-expanded={open}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {t("library.aboveCount", { count })}
            </button>
            {open
              ? above
                  .filter((level) => level.pages.length > 0)
                  .map((level) => (
                    <div
                      key={level.node.kind === "space" ? "space" : level.node.id}
                      className={styles.kLevel}
                    >
                      <LibraryLink node={level.node} className={styles.kLevelName}>
                        {level.title}
                      </LibraryLink>
                      <Pages pages={level.pages} from={from} />
                    </div>
                  ))
              : null}
          </>
        )}
      </div>
    </div>
  );
}
