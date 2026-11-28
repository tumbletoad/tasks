// The pages in the Trash, under the Trash's tasks: newest change first, each with where it was,
// who moved it there and why, and its own Restore. The find field's words find pages too. Read
// again whenever the feed moves a page, or a snapshot replaces what the page knew.
import { useContext, useEffect, useState } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { formatWhen } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import type { TrashedPage } from "./calls.ts";
import css from "./Library.module.css";
import { whoOf } from "./parts.tsx";
import { useLibraryWrites } from "./writes.ts";

const styles = classes(css, [
  "trashed",
  "heading",
  "trashRow",
  "ref",
  "title",
  "line",
  "act",
  "more",
]);

export function TrashedPages({
  q,
  onRows,
}: {
  readonly q: string;
  /** Whether any page is listed: the Trash is not empty then. */
  readonly onRows?: (any: boolean) => void;
}) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const { instances } = useLive();
  const clock = useClock(true);
  const writes = useLibraryWrites();
  const [rows, setRows] = useState<{ list: TrashedPage[]; cursor?: string | undefined }>();
  const [round, setRound] = useState(0);
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        if (reset || changes.some((change) => change.type === "page")) setRound((n) => n + 1);
      }),
    [live],
  );
  useEffect(() => {
    let current = true;
    api.client.page.trashed(q === "" ? {} : { q }).then(
      (answer) => {
        if (current) setRows({ list: answer.rows, cursor: answer.cursor });
      },
      (error: unknown) => {
        // The Trash's tasks say when the service cannot be read: the pages add nothing to it.
        if (current) live.failed(error);
      },
    );
    return () => {
      current = false;
    };
  }, [api, live, q, round]);
  const any = (rows?.list.length ?? 0) > 0;
  useEffect(() => {
    onRows?.(any);
  }, [any, onRows]);
  if (rows === undefined || !any) return null;
  const more = () => {
    const cursor = rows.cursor;
    if (cursor === undefined) return;
    api.client.page.trashed({ ...(q === "" ? {} : { q }), cursor }).then(
      (answer) => {
        setRows((now) => ({ list: [...(now?.list ?? []), ...answer.rows], cursor: answer.cursor }));
      },
      (error: unknown) => {
        live.failed(error);
      },
    );
  };
  return (
    <section className={styles.trashed} aria-labelledby="trashed-pages" data-part="trashed-pages">
      <h2 id="trashed-pages" className={styles.heading}>
        {t("trash.pages")}
      </h2>
      <ul>
        {rows.list.map((page) => {
          const values = {
            on: page.on,
            who: whoOf(page.removed.by, instances, t),
            when: formatWhen(Date.parse(page.removed.at), clock),
          };
          return (
            <li key={page.id} className={styles.trashRow} data-part="trashed-page">
              <span className={styles.ref}>{page.ref}</span>
              <span className={styles.title} dir="auto">
                {page.title}
              </span>
              <span className={styles.line} dir="auto">
                {page.removed.reason === undefined
                  ? t("trash.pageMoved", values)
                  : t("trash.pageMovedWhy", { ...values, why: page.removed.reason })}
              </span>
              <button
                type="button"
                className={styles.act}
                data-part="restore-page"
                aria-label={t("trash.restoreLabel", { ref: page.ref })}
                onClick={() => {
                  writes.untrash(page.ref).then(
                    () => {
                      setRows((now) =>
                        now === undefined
                          ? now
                          : { ...now, list: now.list.filter((row) => row.id !== page.id) },
                      );
                    },
                    (error: unknown) => {
                      if (!live.failed(error)) say(refusalText(error, t("page.trashFailed")));
                    },
                  );
                }}
              >
                {t("trash.restore")}
              </button>
            </li>
          );
        })}
      </ul>
      {rows.cursor === undefined ? null : (
        <button type="button" className={styles.more} onClick={more}>
          {t("completed.more")}
        </button>
      )}
    </section>
  );
}
