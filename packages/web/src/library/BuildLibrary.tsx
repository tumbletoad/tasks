// "Build this project's library", on a project's or an area's Library that has no pages: an
// ordinary task there, with the person's note for agents that says what to build, opened in the
// list so the person can hand it to an agent like any task. The note is the person's, written on
// their click: a task's context is data an agent would not follow.
import { useRouter } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Library.module.css";
import type { LibraryNode } from "./lists.ts";

const styles = classes(css, ["build"]);

export function BuildLibrary({ node }: { readonly node: Exclude<LibraryNode, { kind: "space" }> }) {
  const t = useT();
  const say = useToast();
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  const { api, live } = useContext(Session);
  const edits = useEdits();
  const { areas, projects } = useLive();
  const [sending, setSending] = useState(false);
  const project = node.kind === "project" ? projects.get(node.id) : undefined;
  const areaId = node.kind === "area" ? node.id : project?.area_id;
  const area = areaId === undefined ? undefined : areas.get(areaId);
  const kind = node.kind;
  const build = async (): Promise<void> => {
    const title = t("library.buildTitle", { kind });
    const added = await edits.write(
      (request_id) =>
        api.client.task.add({
          tasks: [
            {
              title,
              ...(area === undefined ? {} : { area: area.title }),
              ...(project === undefined ? {} : { project: project.title }),
            },
          ],
          request_id,
        }),
      () => ({ id: "toast.buildAdded" }),
    );
    const ref = "tasks" in added ? added.tasks[0]?.ref : undefined;
    if (ref === undefined) return;
    await edits.write(
      (request_id) =>
        api.client.entry.add({
          task: ref,
          kind: "note",
          for_agents: true,
          text: t("library.buildBrief", { kind }),
          request_id,
        }),
      () => undefined,
    );
    const space = live.spaceId ?? "";
    const search = { task: ref };
    if (node.kind === "area") {
      await router?.navigate({
        to: "/s/$space/area/$area",
        params: { space, area: node.id },
        search,
      });
    } else if (areaId === undefined) {
      await router?.navigate({
        to: "/s/$space/project/$project",
        params: { space, project: node.id },
        search,
      });
    } else {
      await router?.navigate({
        to: "/s/$space/area/$area/project/$project",
        params: { space, area: areaId, project: node.id },
        search,
      });
    }
  };
  return (
    <button
      type="button"
      className={styles.build}
      data-part="build-library"
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
      {t("library.buildTitle", { kind })}
    </button>
  );
}
