// The line at the top of an archived area's or project's page: it says the group is archived and
// brings it back. A project in an archived area is archived with it, so the line there brings back
// the area, and says so.
import { useContext } from "react";
import { Button } from "react-aria-components";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { archivedGroup } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import type { AreaRow, ProjectRow } from "../live.ts";
import type { Msg } from "../row/model.ts";
import { useLive } from "../store/hooks.ts";
import css from "./Archived.module.css";
import { classes } from "./css.ts";
import { useToast } from "./frame.ts";

const styles = classes(css, ["act", "line", "words"]);

/**
 * Unarchive a group, with an Undo toast: the group is back in the sidebar, or, for a project whose
 * area stays archived, it is unarchived and stays under Archived with that area. Which of the two
 * is what the write's answer says of the project's area, so an area archived a moment ago, which
 * the page has not heard of yet, is still named. Resolves true once the service has the group
 * live; a refusal is said in a toast.
 */
export function useUnarchive(): (
  group: Pick<AreaRow | ProjectRow, "id" | "title">,
  area?: AreaRow,
) => Promise<boolean> {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  return (group, area) => {
    const name = group.title;
    return edits
      .write(
        (request, base) =>
          api.client.group.manage({
            action: "unarchive",
            path: group.id,
            mode: "apply",
            request_id: request,
            ...(base === undefined ? {} : { base }),
          }),
        (result): Msg => {
          // Known only from its receipt, the answer names no area: the page's own rows say it then.
          const stays =
            "receipt" in result
              ? area?.lifecycle === "archived"
                ? area.title
                : undefined
              : result.group?.area?.archived === true
                ? result.group.area.name
                : undefined;
          return stays === undefined
            ? { id: "archived.back", values: { name } }
            : { id: "archived.backInArea", values: { name, area: stays } };
        },
      )
      .then(
        () => true,
        (failed: unknown) => {
          if (!live.failed(failed)) say(refusalText(failed, t("archived.notBack")));
          return false;
        },
      );
  };
}

export function ArchivedLine({
  area,
  project,
}: {
  readonly area?: string | undefined;
  readonly project?: string | undefined;
}) {
  const t = useT();
  const unarchive = useUnarchive();
  const state = useLive();
  const areaRow = area === undefined ? undefined : state.areas.get(area);
  const projectRow = project === undefined ? undefined : state.projects.get(project);
  const shelved = archivedGroup(areaRow, projectRow);
  if (shelved === undefined) return null;
  const name = shelved.row.title;
  // On a live project's page, the area is what keeps it archived: the button names it.
  const byArea = shelved.kind === "area" && project !== undefined;

  return (
    <div className={styles.line} data-part="archived-line">
      <span className={styles.words} dir="auto">
        {byArea ? t("archived.inArea", { area: name }) : t("archived.line")}
      </span>
      <Button
        className={styles.act}
        onPress={() => {
          void unarchive(shelved.row, shelved.kind === "project" ? areaRow : undefined);
        }}
      >
        {byArea ? t("archived.unarchiveArea", { area: name }) : t("archived.unarchive")}
      </Button>
    </div>
  );
}
