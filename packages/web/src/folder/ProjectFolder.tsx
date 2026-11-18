// A project's folder on this machine, at the top of its view: the path with the repository a
// checkout holds, or where else it has one, or none, and the ways to set, change or clear it. The
// line keeps its height while it is read, so the list below never moves.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import type { ProjectFolderView } from "../api.ts";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { Latest } from "../latest.ts";
import { FolderElsewhereIcon, FolderIcon } from "../row/icons.tsx";
import { useLive } from "../store/hooks.ts";
import { FolderDialog, refusalText } from "./FolderDialog.tsx";
import css from "./Folder.module.css";
import { useFolderWrites } from "./writes.ts";

const styles = classes(css, ["act", "acts", "icon", "line", "muted", "path", "repo", "words"]);

export function ProjectFolder({ project }: { readonly project: string }) {
  const t = useT();
  const say = useToast();
  const { api, live } = useContext(Session);
  const writes = useFolderWrites();
  const name = useLive().projects.get(project)?.title ?? "";
  const [view, setView] = useState<ProjectFolderView | "failed">();
  const [choosing, setChoosing] = useState(false);
  // Where the feed was when the folder shown was read: its Change and Clear go with this base, so
  // a folder set elsewhere since, still on its way here, is not replaced unseen.
  const [base, setBase] = useState<string>();
  const reads = useRef(new Latest());

  const load = useCallback(() => {
    const newest = reads.current.begin(project);
    const at = live.store.asOf;
    api.projectFolder(project).then(
      (found) => {
        if (!newest()) return;
        setView(found);
        setBase(at);
      },
      (error: unknown) => {
        if (!live.failed(error) && newest()) setView("failed");
      },
    );
  }, [api, live, project]);

  useEffect(() => {
    setView(undefined);
    load();
  }, [load]);

  // A folder that changed anywhere (here, by an agent, by an undo) is read again.
  useEffect(
    () =>
      live.onChanges(({ changes, reset }) => {
        if (reset || changes.some((c) => c.type === "folder" || c.id === project)) load();
      }),
    [live, load, project],
  );

  const here = view === undefined || view === "failed" ? undefined : view.here;
  const elsewhere = view === undefined || view === "failed" ? [] : view.elsewhere;
  const clear = () => {
    writes.clearProject(project, base).then(load, (error: unknown) => {
      if (!live.failed(error)) say(refusalText(error, t("folder.notCleared")));
    });
  };

  return (
    <div
      className={styles.line}
      data-part="project-folder"
      data-state={view === undefined ? "reading" : here === undefined ? "none" : here.state}
    >
      <span className={styles.icon} aria-hidden="true">
        {here === undefined && elsewhere.length > 0 ? <FolderElsewhereIcon /> : <FolderIcon />}
      </span>
      {view === undefined ? null : view === "failed" ? (
        <span className={`${styles.words} ${styles.muted}`}>{t("folder.lineFailed")}</span>
      ) : here !== undefined ? (
        <span className={styles.words} title={here.folder}>
          <span
            className={`${styles.path} ${here.state === "missing" ? styles.muted : ""}`}
            dir="ltr"
          >
            {here.folder}
          </span>
          {here.repo === undefined ? null : (
            <span className={styles.repo} data-tip={t("place.repoTip")}>
              {t("place.repo", { repo: here.repo })}
            </span>
          )}
          {here.state === "missing" ? (
            <span className={styles.muted}> {t("place.missing")}</span>
          ) : null}
        </span>
      ) : (
        <span className={`${styles.words} ${styles.muted}`} dir="auto">
          {elsewhere.length > 0
            ? t("folder.onlyElsewhere", { machine: elsewhere.join(", ") })
            : t("folder.noneHere")}
        </span>
      )}
      {view === undefined || view === "failed" ? null : (
        <span className={styles.acts}>
          <Button
            className={styles.act}
            onPress={() => {
              setChoosing(true);
            }}
          >
            {here === undefined
              ? t(elsewhere.length > 0 ? "folder.chooseHere" : "folder.choose")
              : t("folder.change")}
          </Button>
          {here === undefined ? null : (
            <>
              <Button className={styles.act} onPress={clear}>
                {t("folder.clear")}
              </Button>
              <Button
                className={styles.act}
                onPress={() => {
                  navigator.clipboard.writeText(here.folder).then(
                    () => {
                      say(t("place.copied"));
                    },
                    () => {
                      say(t("row.copyFailed"));
                    },
                  );
                }}
              >
                {t("place.copy")}
              </Button>
            </>
          )}
        </span>
      )}
      {choosing ? (
        <FolderDialog
          title={t("folder.forProject", { project: name })}
          {...(here === undefined && elsewhere.length > 0
            ? { lead: t("folder.elsewhereLead", { machine: elsewhere.join(", ") }) }
            : here === undefined
              ? {}
              : { lead: t("folder.moveLead") })}
          start={here?.folder ?? ""}
          base={base}
          owner={project}
          onClose={() => {
            setChoosing(false);
          }}
          onChoose={async (folder, base) => {
            await writes.setProject(project, folder, base);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
