// The line at the top of an archived area's or project's page: it says the group is archived and
// brings it back. A project in an archived area is archived with it, so Unarchive there brings back
// the area.
import { useContext } from "react";
import { Button } from "react-aria-components";
import { Session } from "../context.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { archivedGroup } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Archived.module.css";
import { classes } from "./css.ts";
import { useToast } from "./frame.ts";

const styles = classes(css, ["act", "line", "words"]);

export function ArchivedLine({
  area,
  project,
}: {
  readonly area: string;
  readonly project?: string | undefined;
}) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const edits = useEdits();
  const state = useLive();
  const areaRow = state.areas.get(area);
  const projectRow = project === undefined ? undefined : state.projects.get(project);
  const shelved = archivedGroup(areaRow, projectRow);
  if (shelved === undefined) return null;
  const name = shelved.row.title;
  const words =
    shelved.kind === "area" && project !== undefined
      ? t("archived.inArea", { area: name })
      : t("archived.line");

  const unarchive = () => {
    edits
      .write(
        (request, base) =>
          api.client.group.manage({
            action: "unarchive",
            path: shelved.row.id,
            mode: "apply",
            request_id: request,
            ...(base === undefined ? {} : { base }),
          }),
        () => ({ id: "archived.back", values: { name } }),
      )
      .catch((failed: unknown) => {
        if (!live.failed(failed)) say(refusalText(failed, t("archived.notBack")));
      });
  };

  return (
    <div className={styles.line} data-part="archived-line">
      <span className={styles.words} dir="auto">
        {words}
      </span>
      <Button className={styles.act} onPress={unarchive}>
        {t("archived.unarchive")}
      </Button>
    </div>
  );
}
