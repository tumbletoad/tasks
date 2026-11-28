// `/`, what a new tab opens (A2 3.1, A5 3.3): the machine's default space, at its landing view, or
// at the task `ttasks open <task>` named. A machine without a default opens its one space; when it
// has several, or its default is not open, the person chooses, and nothing is chosen for them. A
// machine with no space open asks for a name and makes one, then shows the agent apps it found,
// which can be skipped: a space is all a person needs to start.
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { SignedOut, type MadeSpace } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import css from "./Landing.module.css";
import { useAuth, useMachineApi } from "./session.tsx";
import { AgentApps } from "./AgentApps.tsx";
import { NotOpenNotes } from "./NotOpen.tsx";
import { openedFor } from "./opened.ts";
import { SpaceForm, type SpaceFormMode } from "./SpaceForm.tsx";
import {
  isServed,
  landingSpace,
  listSpaces,
  notOpen,
  type NotOpen,
  type SpaceList,
} from "./spaces.ts";
import { LANDING } from "@ttasks/client/today";
import { classes } from "./css.ts";

const styles = classes(css, ["line", "page", "space", "spaces", "start"]);

export function Landing({
  task,
  unknown = false,
}: {
  readonly task?: string;
  /** The route named a space this machine does not have: say so, and choose nothing for them. */
  readonly unknown?: boolean;
}) {
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
  const space = unknown ? undefined : landingSpace(list);
  if (space !== undefined) {
    return task === undefined ? (
      <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />
    ) : (
      <Navigate to="/s/$space/task/$task" params={{ space, task }} replace />
    );
  }
  const served = list.spaces.filter(isServed);
  const closed = notOpen(list);
  const note = unknown ? (
    <p className={styles.line} role="alert" data-part="unknown-space">
      {t("app.unknownSpace")}
    </p>
  ) : null;
  if (served.length === 0) return <FirstStart closed={closed} note={note} />;
  return (
    <main className={styles.page}>
      {note}
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

/** No space open yet: a name makes one, then the agent apps, then the space itself. */
function FirstStart({
  closed,
  note,
}: {
  readonly closed: readonly NotOpen[];
  readonly note: ReactNode;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<{ readonly mode: SpaceFormMode } | { readonly made: MadeSpace }>(
    { mode: "new" },
  );
  return (
    <main className={styles.start}>
      {note}
      <NotOpenNotes spaces={closed} className={styles.line} />
      {"mode" in step ? (
        <SpaceForm
          mode={step.mode}
          onMode={(mode) => {
            setStep({ mode });
          }}
          onMade={(made) => {
            setStep({ made });
          }}
        />
      ) : (
        <>
          {step.made.notRemembered === undefined ? null : (
            <p className={styles.line} role="alert">
              {step.made.notRemembered}
            </p>
          )}
          <AgentApps
            space={step.made.id}
            firstStart
            headingLevel={1}
            onDone={() => {
              openedFor(step.made.id, step.made.copy);
              void navigate({
                to: "/s/$space/$view",
                params: { space: step.made.id, view: LANDING },
                replace: true,
              });
            }}
          />
        </>
      )}
    </main>
  );
}
