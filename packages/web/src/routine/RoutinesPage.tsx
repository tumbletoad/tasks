// The Routines page: every routine that comes back, Due, Coming and Paused, each opening its card in
// place. The card's times are get_task's routine view, read again when the routine changes.
import { useContext, useEffect, useState } from "react";
import type { RoutineRow } from "@ttasks/client/store";
import { Session } from "../context.ts";
import { useClock } from "../row/useClock.ts";
import { useLive } from "../store/hooks.ts";
import { useMakeRoutine, useRoutineActions } from "./actions.ts";
import { NewRoutine } from "./NewRoutine.tsx";
import { RoutineLists } from "./Routine.tsx";
import { RoutineCard, type RoutineEntryView } from "./RoutineCard.tsx";

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
      <NewRoutine clock={clock} onMake={(title, rule) => make({ title }, rule, clock.timeZone)} />
    </>
  );
}

/** An open routine's card, with its times read for the version the page shows. */
function OpenCard({ routine }: { readonly routine: RoutineRow }) {
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
