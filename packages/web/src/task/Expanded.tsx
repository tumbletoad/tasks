// The seam between the row and the expanded task (A5 3.7). The row (M5.03) owns its expanded
// state, its `aria-expanded` and the region it opens; what the region holds is this component's.
// Until M5.06 builds the expanded task (content, facts, sources, thread, composer with its strip),
// it holds the skeleton's parts: a button per pinned instance and Copy, then the thread of log
// entries and launch receipts, live. M5.06 replaces this file and keeps its props.
import type { Instance, Receipt } from "../api.ts";
import { classes } from "../app/css.ts";
import { useT } from "../i18n/intl.tsx";
import { tileClick, tileState } from "../row/launch.ts";
import type { RowActions } from "../row/actions.ts";
import type { TaskRow } from "../store/rows.ts";
import css from "./Expanded.module.css";
import { Thread } from "./Thread.tsx";

const styles = classes(css, ["strip", "button", "glyph"]);

export interface ExpandedProps {
  readonly task: TaskRow;
  readonly receipts: readonly Receipt[];
  readonly instances: readonly Instance[];
  readonly actions: RowActions;
}

export function Expanded({ task, receipts, instances, actions }: ExpandedProps) {
  const t = useT();
  return (
    <>
      <div className={styles.strip} role="toolbar" aria-label={task.title}>
        {instances.map((instance) => {
          const state = tileState(receipts, instance.key);
          return (
            <button
              key={instance.key}
              type="button"
              className={styles.button}
              data-state={state}
              data-ring={instance.ring}
              aria-disabled={state === "opening"}
              onClick={() => {
                const action = tileClick(state);
                if (action === "open") actions.open(task, instance);
              }}
            >
              <span className={styles.glyph} aria-hidden="true">
                {instance.glyph}
              </span>
              {t("row.openIn", { label: instance.label })}
            </button>
          );
        })}
        <button
          type="button"
          className={styles.button}
          aria-label={t("row.copyFor", { title: task.title })}
          onClick={() => {
            actions.copy(task);
          }}
        >
          {t("row.copy")}
        </button>
      </div>
      <Thread task={task.id} receipts={receipts} instances={instances} />
    </>
  );
}
