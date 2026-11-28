// What the page asks of a routine: check off or skip its open time, pause, resume, finish it for
// good. Each is a person's write in turn with the tab's others (edits.write), against what the
// screen shows, and its toast offers Undo, which takes back a check-off or a skip until the routine
// changes again, and a finish as a task's.
import { useContext, useMemo } from "react";
import type { RoutineRow } from "@ttasks/client/store";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { useToast } from "../app/frame.ts";
import type { Msg } from "../row/model.ts";
import type { RoutineActions } from "./Routine.tsx";
import type { RoutineCardActions } from "./RoutineCard.tsx";

type Action = "done" | "skip" | "pause" | "resume" | "finish";

const SAID: Readonly<Record<Action, MessageId>> = {
  done: "routine.saidDone",
  skip: "routine.saidSkip",
  pause: "routine.saidPause",
  resume: "routine.saidResume",
  finish: "routine.saidFinish",
};

export function useRoutineActions(): RoutineActions & RoutineCardActions {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => {
    // A new title or schedule; true once it is saved, so the card keeps what was typed until then.
    const change: RoutineCardActions["change"] = (routine, changed) =>
      edits
        .write(
          (request, base) =>
            api.client.routine.manage({
              action: "change",
              routine: routine.ref,
              ...changed,
              request_id: request,
              ...(base === undefined ? {} : { base }),
            }),
          () => ({ id: "routine.saidChange", values: { title: routine.title } }),
          { undo: true },
        )
        .then(
          () => true,
          (failed: unknown) => {
            if (!live.failed(failed)) say(refusalText(failed, t("routine.notSaved")));
            return false;
          },
        );
    const act = (action: Action) => (routine: RoutineRow) => {
      void edits
        .write(
          (request, base) =>
            api.client.routine.manage({
              action,
              routine: routine.ref,
              request_id: request,
              ...(base === undefined ? {} : { base }),
            }),
          () => ({ id: SAID[action], values: { title: routine.title } }),
          { undo: true },
        )
        .catch((failed: unknown) => {
          if (!live.failed(failed)) say(refusalText(failed, t("routine.notSaved")));
        });
    };
    return {
      done: act("done"),
      skip: act("skip"),
      pause: act("pause"),
      resume: act("resume"),
      finish: act("finish"),
      change,
    };
  }, [api, edits, live, say, t]);
}

/** Makes a routine you do: a new one with its title, or the task that becomes one. */
export function useMakeRoutine(): (
  made: { readonly title: string } | { readonly task: string },
  rule: string,
  timeZone: string,
  base?: string,
) => Promise<boolean> {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  return (made, rule, timeZone, base) =>
    edits
      .write(
        (request, seen) =>
          api.client.routine.manage({
            action: "make",
            ...("task" in made ? { from_task: made.task } : { title: made.title }),
            rule,
            tz: timeZone,
            request_id: request,
            ...(seen === undefined ? {} : { base: seen }),
          }),
        (result): Msg | undefined =>
          "routine" in result
            ? { id: "routine.saidMade", values: { title: result.routine.title } }
            : undefined,
        base === undefined ? {} : { base },
      )
      .then(
        () => true,
        (failed: unknown) => {
          if (!live.failed(failed)) say(refusalText(failed, t("routine.notSaved")));
          return false;
        },
      );
}
