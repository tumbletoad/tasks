// Today's Changes beside the tasks: the pages an agent changed last in the past seven days, newest
// first, under a heading of their own, each to its page. From the live store's pages, which carry
// who changed each last and when: a page the person changed after an agent is the person's again,
// and a page in the Trash leaves.
import { useMemo } from "react";
import { classes } from "../app/css.ts";
import { CHANGES_DAYS, CHANGES_LIMIT } from "../app/views.ts";
import { useT } from "../i18n/intl.tsx";
import listCss from "../list/List.module.css";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import css from "./Library.module.css";
import { agentPages } from "./lists.ts";
import { PageList } from "./parts.tsx";

const list = classes(listCss, ["label", "name"]);
const styles = classes(css, ["changes"]);

export function PageChanges() {
  const t = useT();
  const { pages } = useLive();
  const clock = useClock(true);
  const changed = useMemo(
    () => agentPages(pages.values(), clock.now, CHANGES_DAYS, CHANGES_LIMIT),
    [pages, clock.now],
  );
  if (changed.length === 0) return null;
  return (
    <section className={styles.changes} data-part="page-changes">
      <h2 className={list.label}>
        <span className={list.name}>{t("today.pageChanges")}</span>
      </h2>
      <PageList pages={changed} from={t("nav.today")} label={t("today.pageChanges")} />
    </section>
  );
}
