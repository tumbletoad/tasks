// "Build this project's library", on a project's or an area's Library that has no pages, and "Tidy
// this project's library" on one that has: an ordinary task there, with the person's note for
// agents that says what to build or how to tidy, opened in the list so the person can hand it to an
// agent like any task. The note is the person's, written on
// their click: a task's context is data an agent would not follow. A task's add takes no note for
// agents, so the two go one after the other: once the task is made its reference is kept, and a
// note that failed is tried again on that task, never with a second one.
import { useRouter } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { filedAs, trail } from "@ttasks/client/store";
import { useLive } from "../store/hooks.ts";
import css from "./Library.module.css";
import type { LibraryNode } from "./lists.ts";

const styles = classes(css, ["build"]);

export function BuildLibrary({
  node,
  job,
}: {
  readonly node: Exclude<LibraryNode, { kind: "space" }>;
  readonly job: "build" | "tidy";
}) {
  const t = useT();
  const say = useToast();
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  const { api, live } = useContext(Session);
  const edits = useEdits();
  const { nodes } = useLive();
  const [sending, setSending] = useState(false);
  /** The task made for it whose note for agents did not land yet. */
  const [made, setMade] = useState<string | undefined>(undefined);
  const [area, project] = trail(nodes, node.id);
  const filed = area === undefined ? {} : filedAs(area, project);
  const kind = filed.area !== undefined && filed.project === undefined ? "area" : "project";
  const add = async (): Promise<string | undefined> => {
    const title = t(`library.${job}Title`, { kind });
    const added = await edits.write(
      (request_id) =>
        api.client.task.add({
          tasks: [
            {
              title,
              ...(filed.area === undefined ? {} : { area: filed.area.title }),
              ...(filed.project === undefined ? {} : { project: filed.project.title }),
            },
          ],
          request_id,
        }),
      () => ({ id: `toast.${job}Added` }),
    );
    return "tasks" in added ? added.tasks[0]?.ref : undefined;
  };
  const build = async (): Promise<void> => {
    const ref = made ?? (await add());
    if (ref === undefined) return;
    setMade(ref);
    try {
      await edits.write(
        (request_id) =>
          api.client.entry.add({
            task: ref,
            kind: "note",
            for_agents: true,
            text: t(`library.${job}Brief`, { kind }),
            request_id,
          }),
        () => undefined,
      );
    } catch (error) {
      if (!live.failed(error)) say(t("library.buildNoteFailed", { ref }));
      return;
    }
    setMade(undefined);
    const space = live.spaceId ?? "";
    const search = { task: ref };
    await router?.navigate({
      to: "/s/$space/project/$project",
      params: { space, project: node.id },
      search,
    });
  };
  return (
    <button
      type="button"
      className={styles.build}
      data-part={`${job}-library`}
      aria-disabled={sending || undefined}
      onClick={() => {
        if (sending) return;
        setSending(true);
        build().then(
          () => {
            setSending(false);
          },
          (error: unknown) => {
            setSending(false);
            if (!live.failed(error)) say(refusalText(error, t("library.buildFailed")));
          },
        );
      }}
    >
      {made === undefined
        ? t(`library.${job}Title`, { kind })
        : t("library.buildNote", { ref: made })}
    </button>
  );
}
