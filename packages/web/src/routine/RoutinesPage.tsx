// The Routines page: every routine that comes back, Due, Coming and Paused, each opening its card in
// place. The card's times are get_task's routine view, read again when the routine changes.
import { Fragment, useContext, useEffect, useState } from "react";
import type { RoutineRow } from "@ttasks/client/store";
import { Session } from "../context.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { useMakeRoutine, useRoutineActions } from "./actions.ts";
import { NewRoutine } from "./NewRoutine.tsx";
import { classes } from "../app/css.ts";
import { useT } from "../i18n/intl.tsx";
import css from "./Routine.module.css";
import { RoutineItem, RoutineLists } from "./Routine.tsx";
import { RoutineCard, type RoutineEntryView } from "./RoutineCard.tsx";

const styles = classes(css, ["group"]);

export function RoutinesPage() {
  const state = useLive();
  const clock = useClock(false);
  const actions = useRoutineActions();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const make = useMakeRoutine();
  return (
    <>
      <RoutineLists
        routines={state.routines.values()}
        clock={clock}
        actions={actions}
        open={open}
        onOpen={(routine) => {
          setOpen((now) => (now === routine.id ? undefined : routine.id));
        }}
        below={(routine) => <OpenCard routine={routine} />}
      />
      {/* Only a space that keeps routines makes one, as the side menu lists them only there. */}
      {state.space?.tree === true ? (
        <NewRoutine clock={clock} onMake={(title, rule) => make({ title }, rule, clock.timeZone)} />
      ) : null}
    </>
  );
}

/** An open routine's card, with its times read for the version the page shows. */
export function OpenCard({ routine }: { readonly routine: RoutineRow }) {
  const { api } = useContext(Session);
  const clock = useClock(false);
  const actions = useRoutineActions();
  const [entries, setEntries] = useState<readonly RoutineEntryView[]>([]);
  useEffect(() => {
    let live = true;
    api.client.task.get({ task: routine.ref }).then(
      (read) => {
        if (live && read.view === "routine") setEntries(read.history);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, routine.ref, routine.version]);
  return <RoutineCard routine={routine} entries={entries} clock={clock} actions={actions} />;
}

/**
 * The routines finished for good, newest first, for Completed: each marked as a routine, its card
 * with its times done. Undo of the finish, or of its toast, brings one back.
 */
export function FinishedRoutines() {
  const t = useT();
  const state = useLive();
  const clock = useClock(false);
  const actions = useRoutineActions();
  const [open, setOpen] = useState<string | undefined>(undefined);
  const finished = [...state.routines.values()]
    .filter((r) => r.lifecycle !== "active")
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  if (finished.length === 0) return null;
  return (
    <section data-part="routines-finished">
      <h2 className={styles.group}>{t("routines.finished")}</h2>
      {finished.map((routine) => (
        <Fragment key={routine.id}>
          <RoutineItem
            routine={routine}
            clock={clock}
            actions={actions}
            onOpen={(r) => {
              setOpen((now) => (now === r.id ? undefined : r.id));
            }}
          />
          {open === routine.id ? <OpenCard routine={routine} /> : null}
        </Fragment>
      ))}
    </section>
  );
}
