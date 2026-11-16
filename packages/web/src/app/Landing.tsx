// `/`, what a new tab opens (A2 3.1, A5 3.3): the machine's default space, at its landing view, or
// at the task `tasks open <task>` named. A machine without a default opens its one space; when it
// has several, or its default is not open, the person chooses, and nothing is chosen for them.
import { Link, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SignedOut } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import css from "./Landing.module.css";
import { useAuth, useMachineApi } from "./session.tsx";
import { NotOpenNotes } from "./NotOpen.tsx";
import { isServed, landingSpace, listSpaces, notOpen, type SpaceList } from "./spaces.ts";
import { LANDING } from "./views.ts";
import { classes } from "./css.ts";

const styles = classes(css, ["line", "page", "space", "spaces"]);

export function Landing({ task }: { readonly task?: string }) {
  const t = useT();
  const auth = useAuth();
  const api = useMachineApi();
  const [list, setList] = useState<SpaceList | "failed" | undefined>(undefined);

  useEffect(() => {
    let current = true;
    listSpaces(api).then(
      (found) => {
        if (current) setList(found);
      },
      (error: unknown) => {
        if (error instanceof SignedOut) auth.signedOut();
        else if (current) setList("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [api, auth]);

  useEffect(() => {
    document.title = t("app.pickSpace");
  }, [t]);

  if (list === undefined) return <p className={styles.line}>{t("app.starting")}</p>;
  if (list === "failed") return <p className={styles.line}>{t("space.listFailed")}</p>;
  const space = landingSpace(list);
  if (space !== undefined) {
    return task === undefined ? (
      <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />
    ) : (
      <Navigate to="/s/$space/task/$task" params={{ space, task }} replace />
    );
  }
  const served = list.spaces.filter(isServed);
  const closed = notOpen(list);
  if (served.length === 0) {
    return closed.length === 0 ? (
      <p className={styles.line}>{t("app.noSpaces")}</p>
    ) : (
      <main className={styles.page}>
        <NotOpenNotes spaces={closed} className={styles.line} />
      </main>
    );
  }
  return (
    <main className={styles.page}>
      <p className={styles.line}>{t("app.pickSpace")}</p>
      <ul className={styles.spaces}>
        {served.map((item) => (
          <li key={item.id}>
            {/* A task link keeps its task through the choice. */}
            {task === undefined ? (
              <Link
                to="/s/$space/$view"
                params={{ space: item.id, view: LANDING }}
                className={styles.space}
              >
                <span dir="auto">{item.name}</span>
              </Link>
            ) : (
              <Link
                to="/s/$space/task/$task"
                params={{ space: item.id, task }}
                className={styles.space}
              >
                <span dir="auto">{item.name}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
      <NotOpenNotes spaces={closed} className={styles.line} />
    </main>
  );
}
