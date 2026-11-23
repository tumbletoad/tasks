// This machine's agent apps: what was found, and per app and home two switches, "Open tasks in
// this app" and "Give this app the TTasks tools". What turning them over changes is listed in plain
// words, with exactly what is written one click away, and nothing changes before Apply. The first
// start shows it with the usual choice made (every switch that can be on is on) and a way to skip;
// Settings shows it as it stands, for a person who skipped or installs an app later.
import { useCallback, useEffect, useId, useState } from "react";
import { Button, Heading, SwitchButton, SwitchField } from "react-aria-components";
import { Refused, SignedOut } from "../api.ts";
import { useT, type Translate } from "../i18n/intl.tsx";
import {
  applyApps,
  carryChoices,
  choose,
  initialChoices,
  pendingOf,
  readApps,
  switchKey,
  type AppRow,
  type AppsView,
  type Outcome,
  type Part,
  type PartName,
  type Pending,
} from "./apps.ts";
import { classes } from "./css.ts";
import { useAuth, useMachineApi } from "./session.tsx";
import settingsCss from "./Settings.module.css";
import css from "./Setup.module.css";

const styles = classes(css, [
  "actions",
  "app",
  "apps",
  "changes",
  "detail",
  "error",
  "head",
  "home",
  "lead",
  "list",
  "name",
  "note",
  "primary",
  "quiet",
  "secondary",
  "title",
  "why",
]);
const switches = classes(settingsCss, ["switch", "track", "thumb", "name"]);

/** A switch turned off whose entry stayed in its file: the tools are off all the same. */
interface Kept {
  readonly label: string;
  readonly file: string;
  /** The person changed the entry, so it is theirs. */
  readonly edited: boolean;
}

/** What the last Apply came to, for the lines under the list. */
type Said =
  | { readonly kind: "done"; readonly desktop: boolean; readonly kept: readonly Kept[] }
  | { readonly kind: "partly"; readonly labels: readonly string[]; readonly kept: readonly Kept[] }
  | { readonly kind: "stale" | "failed" | "unknown" | "busy" };

export function AgentApps({
  space,
  firstStart = false,
  onDone,
  onOpenChanged,
  headingLevel = 2,
  headingClass,
}: {
  /** The space a new entry names. */
  readonly space: string;
  /** The first start: the usual choice made, Skip, and `onDone` once it is applied or skipped. */
  readonly firstStart?: boolean;
  readonly onDone?: () => void;
  /** What Open offers changed: the tab takes a fresh snapshot for its tiles. */
  readonly onOpenChanged?: () => void;
  readonly headingLevel?: 1 | 2;
  /** The heading's look where the page around it has its own (Settings). */
  readonly headingClass?: string;
}) {
  const t = useT();
  const api = useMachineApi();
  const auth = useAuth();
  const detailId = useId();
  const [view, setView] = useState<AppsView | "failed" | undefined>(undefined);
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [details, setDetails] = useState(false);

  const signedOut = useCallback(
    (error: unknown): boolean => {
      if (!(error instanceof SignedOut)) return false;
      auth.signedOut();
      return true;
    },
    [auth],
  );

  useEffect(() => {
    let current = true;
    readApps(api, space).then(
      (found) => {
        if (!current) return;
        setView(found);
        setChoices(initialChoices(found, firstStart));
      },
      (error: unknown) => {
        if (current && !signedOut(error)) setView("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [api, space, firstStart, signedOut]);

  const heading = (
    <Heading level={headingLevel} className={headingClass ?? styles.title}>
      {t("apps.title")}
    </Heading>
  );
  if (view === undefined) {
    return (
      <section className={styles.apps} aria-busy="true">
        {heading}
        <p className={styles.lead}>{t("apps.looking")}</p>
      </section>
    );
  }
  if (view === "failed") {
    return (
      <section className={styles.apps}>
        {heading}
        <p className={styles.error}>{t("apps.failed")}</p>
        {firstStart ? <FirstStartEnd t={t} onDone={onDone} /> : null}
      </section>
    );
  }

  const pending = pendingOf(view, choices);
  const turn = (row: AppRow, part: PartName, on: boolean) => {
    setSaid(undefined);
    setChoices((before) => choose(view, before, row, part, on));
  };

  const apply = () => {
    if (busy || pending.length === 0) return;
    setBusy(true);
    setSaid(undefined);
    applyApps(api, space, pending)
      .then(
        (answer) => {
          if (!answer.applied) {
            // Something changed since it was shown: nothing was written, and this is how it is now.
            setView(answer.view);
            setChoices((before) => carryChoices(answer.view, before));
            setSaid({ kind: "stale" });
            return;
          }
          setView(answer.view);
          setChoices(initialChoices(answer.view, false));
          setDetails(false);
          const failed = answer.outcomes.filter((o) => o.result === "failed");
          const done = answer.outcomes.filter((o) => o.result === "done");
          const pendingOf = (o: Outcome) =>
            pending.find((p) => p.row.key === o.key && p.part === o.part);
          const kept = done.flatMap((o): Kept[] => {
            const p = pendingOf(o);
            return o.kept && p !== undefined
              ? [{ label: p.row.label, file: p.found.file, edited: o.reason === "edited" }]
              : [];
          });
          // A failed one may have changed machine.toml too: the tiles follow either way.
          if (answer.outcomes.some((o) => o.part === "open")) onOpenChanged?.();
          if (failed.length > 0) {
            const labels = failed.flatMap((o) => pendingOf(o)?.row.label ?? []);
            setSaid({ kind: "partly", labels: [...new Set(labels)], kept });
            return;
          }
          const desktop = done.some(
            (o) =>
              o.part === "tools" &&
              pending.some((p) => p.row.key === o.key && p.row.app === "claude-desktop"),
          );
          setSaid({ kind: "done", desktop, kept });
          if (firstStart) onDone?.();
        },
        (error: unknown) => {
          if (signedOut(error)) return;
          if (error instanceof Refused && error.code === "conflict") {
            setSaid({ kind: "busy" });
            return;
          }
          // Part of it may have been written: the page shows how things stand now, or says that it
          // could not tell.
          return readApps(api, space).then(
            (found) => {
              setView(found);
              setChoices((before) => carryChoices(found, before));
              setSaid({ kind: "failed" });
              onOpenChanged?.();
            },
            (again: unknown) => {
              if (!signedOut(again)) setSaid({ kind: "unknown" });
            },
          );
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section className={styles.apps} aria-busy={busy}>
      {heading}
      <p className={styles.lead}>{t(firstStart ? "apps.leadFirst" : "apps.lead")}</p>
      {view.record === undefined ? null : (
        <p className={styles.note} data-part="record" role="status">
          {t("apps.recordUnreadable", { file: view.record })}
        </p>
      )}
      {view.rows.length === 0 ? (
        <p className={styles.note}>{t("apps.none")}</p>
      ) : (
        <ul className={styles.list}>
          {view.rows.map((row) => (
            <li key={row.key} className={styles.app} data-app={row.app}>
              <div className={styles.head}>
                <span className={styles.name}>{row.label}</span>
                {row.home === null ? null : (
                  <span className={styles.home} data-machine="" dir="ltr">
                    {row.home}
                  </span>
                )}
              </div>
              {row.also.map((host) => (
                <p key={host} className={styles.why}>
                  {t("apps.also", { host: host.replace("-", "_") })}
                </p>
              ))}
              {(["open", "tools"] as const).map((part) => {
                const found = row[part];
                if (found === undefined) return null;
                return (
                  <Switch
                    key={part}
                    t={t}
                    row={row}
                    part={part}
                    found={found}
                    on={choices.get(switchKey(row.key, part)) ?? found.on}
                    busy={busy}
                    onChange={(on) => {
                      turn(row, part, on);
                    }}
                  />
                );
              })}
            </li>
          ))}
        </ul>
      )}
      {pending.length === 0 ? null : (
        <div className={styles.changes} data-part="changes">
          <Heading level={headingLevel + 1}>{t("apps.changes")}</Heading>
          <ul>
            {pending.map((p) => (
              <li key={switchKey(p.row.key, p.part)}>{changeText(t, p)}</li>
            ))}
          </ul>
          <div>
            <Button
              className={styles.quiet}
              aria-expanded={details}
              aria-controls={detailId}
              onPress={() => {
                setDetails((open) => !open);
              }}
            >
              {t(details ? "apps.hideDetails" : "apps.showDetails")}
            </Button>
          </div>
          {details ? (
            <pre id={detailId} className={styles.detail} dir="ltr">
              {pending
                .map((p) => [`# ${p.found.file}`, ...p.found.detail, ""].join("\n"))
                .join("\n")}
            </pre>
          ) : null}
        </div>
      )}
      {said === undefined ? null : <SaidLine t={t} said={said} />}
      <div className={styles.actions}>
        {pending.length > 0 ? (
          <Button className={styles.primary} isDisabled={busy} onPress={apply}>
            {t(busy ? "apps.applying" : "apps.apply")}
          </Button>
        ) : firstStart ? (
          <Button className={styles.primary} onPress={() => onDone?.()}>
            {t("apps.continue")}
          </Button>
        ) : null}
        {firstStart && pending.length > 0 ? (
          <Button className={styles.secondary} isDisabled={busy} onPress={() => onDone?.()}>
            {t("apps.skip")}
          </Button>
        ) : null}
      </div>
      <p className={styles.note}>{t(firstStart ? "apps.laterFirst" : "apps.signIn")}</p>
    </section>
  );
}

/** One switch, and why it cannot be turned over here or what to know about it. */
function Switch({
  t,
  row,
  part,
  found,
  on,
  busy,
  onChange,
}: {
  readonly t: Translate;
  readonly row: AppRow;
  readonly part: PartName;
  readonly found: Part;
  readonly on: boolean;
  readonly busy: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const whyId = useId();
  const why = found.why;
  return (
    <>
      <SwitchField
        isSelected={on}
        isDisabled={busy || found.change === null}
        onChange={onChange}
        {...(why === undefined ? {} : { "aria-describedby": whyId })}
      >
        <SwitchButton className={switches.switch}>
          <span className={switches.track} aria-hidden="true">
            <span className={switches.thumb} />
          </span>
          <span className={switches.name}>
            {t(part === "open" ? "apps.open" : "apps.tools", { label: row.label })}
          </span>
        </SwitchButton>
      </SwitchField>
      {why === undefined ? null : (
        <p id={whyId} className={styles.why}>
          {t("apps.why", {
            why,
            on: found.on ? "yes" : "no",
            file: found.file,
            space: found.space?.name ?? t("apps.otherSpace"),
          })}
        </p>
      )}
    </>
  );
}

/** A switch turned over, in plain words, with the file it changes. */
function changeText(t: Translate, p: Pending): string {
  return t("apps.change", {
    part: p.part,
    on: p.on ? "yes" : "no",
    label: p.row.label,
    file: p.found.file,
  });
}

/** Each switch turned off whose entry stayed: the tools are off, and where the entry is. */
function KeptLines({ t, kept }: { readonly t: Translate; readonly kept: readonly Kept[] }) {
  return kept.map((k) => (
    <p key={k.label + k.file} className={styles.note} data-part="kept">
      {t(k.edited ? "apps.keptEdited" : "apps.kept", { label: k.label, file: k.file })}
    </p>
  ));
}

function SaidLine({ t, said }: { readonly t: Translate; readonly said: Said }) {
  switch (said.kind) {
    case "done":
      return (
        <div role="status">
          <p className={styles.note}>{t(said.desktop ? "apps.doneDesktop" : "apps.done")}</p>
          <KeptLines t={t} kept={said.kept} />
        </div>
      );
    case "partly":
      return (
        <div role="alert">
          <p className={styles.error}>{t("apps.partly", { apps: said.labels.join(", ") })}</p>
          <KeptLines t={t} kept={said.kept} />
        </div>
      );
    default:
      return (
        <p className={styles.error} role="alert">
          {t(
            said.kind === "stale"
              ? "apps.stale"
              : said.kind === "busy"
                ? "apps.busy"
                : said.kind === "unknown"
                  ? "apps.unknown"
                  : "apps.applyFailed",
          )}
        </p>
      );
  }
}

function FirstStartEnd({
  t,
  onDone,
}: {
  readonly t: Translate;
  readonly onDone?: (() => void) | undefined;
}) {
  return (
    <div className={styles.actions}>
      <Button className={styles.primary} onPress={() => onDone?.()}>
        {t("apps.continue")}
      </Button>
    </div>
  );
}
