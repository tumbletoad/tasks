// New space and Open folder: one name and one button make a space, its prefix and folder proposed
// from the name and shown, and changed only behind a small "Choose another prefix or folder". Open
// folder takes a folder that holds a space already. The first start, the space switcher and any
// later visit use this same form.
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import { Button, Heading } from "react-aria-components";
import { Refused, SignedOut, type MadeSpace } from "../api.ts";
import { FolderField } from "../folder/FolderField.tsx";
import { useT } from "../i18n/intl.tsx";
import { classes } from "./css.ts";
import { useAuth, useMachineApi } from "./session.tsx";
import css from "./Setup.module.css";

const styles = classes(css, [
  "actions",
  "error",
  "field",
  "form",
  "input",
  "label",
  "lead",
  "note",
  "primary",
  "quiet",
  "title",
]);

/** How long the name rests before its proposal is asked for. */
const PROPOSE_MS = 250;

export type SpaceFormMode = "new" | "open";

export function SpaceForm({
  mode,
  onMode,
  onMade,
  headingLevel = 1,
}: {
  readonly mode: SpaceFormMode;
  readonly onMode: (mode: SpaceFormMode) => void;
  readonly onMade: (space: MadeSpace) => void;
  readonly headingLevel?: 1 | 2;
}) {
  return mode === "new" ? (
    <NewSpace onMode={onMode} onMade={onMade} headingLevel={headingLevel} />
  ) : (
    <OpenFolder onMode={onMode} onMade={onMade} headingLevel={headingLevel} />
  );
}

/**
 * A text field with its label: a native label for its input, which names it without
 * `aria-labelledby` (Firefox's page process crashes when a name is read through a label that way).
 */
function Field({
  label,
  onChange,
  ...input
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly autoFocus?: boolean;
  readonly "aria-describedby"?: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        type="text"
        spellCheck={false}
        className={styles.input}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

/** What the service said when it refused, or the page's own words. */
function useFailure(): (error: unknown, fallback: string) => string | undefined {
  const auth = useAuth();
  return (error, fallback) => {
    if (error instanceof SignedOut) {
      auth.signedOut();
      return undefined;
    }
    return error instanceof Refused && error.said !== undefined ? error.said : fallback;
  };
}

function NewSpace({
  onMode,
  onMade,
  headingLevel,
}: {
  readonly onMode: (mode: SpaceFormMode) => void;
  readonly onMade: (space: MadeSpace) => void;
  readonly headingLevel: 1 | 2;
}) {
  const t = useT();
  const api = useMachineApi();
  const failure = useFailure();
  const proposalId = useId();
  const [name, setName] = useState("");
  const [proposal, setProposal] = useState<{ prefix: string; folder: string } | undefined>();
  const [more, setMore] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (name.trim() === "") {
      setProposal(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.proposeSpace(name.trim()).then(
        (found) => {
          if (current) setProposal(found);
        },
        () => undefined,
      );
    }, PROPOSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, name]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    setBusy(true);
    setError(undefined);
    api
      .createSpace({
        name: name.trim(),
        ...(more && prefix.trim() !== "" ? { prefix: prefix.trim().toUpperCase() } : {}),
        ...(more && folder.trim() !== "" ? { folder: folder.trim() } : {}),
      })
      .then(onMade, (failed: unknown) => {
        setError(failure(failed, t("start.failed")));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <Heading level={headingLevel} className={styles.title}>
        {t("start.title")}
      </Heading>
      <p className={styles.lead}>{t("start.lead")}</p>
      <Field
        label={t("start.name")}
        value={name}
        onChange={setName}
        required
        maxLength={100}
        autoFocus
        aria-describedby={proposalId}
        placeholder={t("start.namePlaceholder")}
      />
      <p id={proposalId} className={styles.note} aria-live="polite">
        {proposal === undefined
          ? t("start.where")
          : t("start.proposal", { prefix: proposal.prefix, folder: proposal.folder })}
      </p>
      {more ? (
        <>
          <Field
            label={t("start.prefix")}
            value={prefix}
            onChange={setPrefix}
            maxLength={6}
            placeholder={proposal?.prefix ?? ""}
          />
          <FolderField
            api={api}
            label={t("start.folder")}
            value={folder}
            onChange={setFolder}
            make={false}
            placeholder={proposal?.folder ?? ""}
          />
          <p className={styles.note}>{t("start.moreNote")}</p>
        </>
      ) : null}
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" className={styles.primary} isDisabled={busy || name.trim() === ""}>
          {t(busy ? "start.making" : "start.make")}
        </Button>
        {more ? null : (
          <Button
            className={styles.quiet}
            onPress={() => {
              setMore(true);
            }}
          >
            {t("start.change")}
          </Button>
        )}
      </div>
      <Button
        className={styles.quiet}
        onPress={() => {
          onMode("open");
        }}
      >
        {t("start.openInstead")}
      </Button>
    </form>
  );
}

function OpenFolder({
  onMode,
  onMade,
  headingLevel,
}: {
  readonly onMode: (mode: SpaceFormMode) => void;
  readonly onMade: (space: MadeSpace) => void;
  readonly headingLevel: 1 | 2;
}) {
  const t = useT();
  const api = useMachineApi();
  const failure = useFailure();
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || folder.trim() === "") return;
    setBusy(true);
    setError(undefined);
    api
      .openSpace(folder.trim())
      .then(onMade, (failed: unknown) => {
        setError(failure(failed, t("start.openFailed")));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      <Heading level={headingLevel} className={styles.title}>
        {t("start.openTitle")}
      </Heading>
      <p className={styles.lead}>{t("start.openLead")}</p>
      <FolderField
        api={api}
        label={t("start.folder")}
        value={folder}
        onChange={setFolder}
        make={false}
        autoFocus
        placeholder={t("start.folderPlaceholder")}
      />
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" className={styles.primary} isDisabled={busy || folder.trim() === ""}>
          {t(busy ? "start.opening" : "start.open")}
        </Button>
      </div>
      <Button
        className={styles.quiet}
        onPress={() => {
          onMode("new");
        }}
      >
        {t("start.newInstead")}
      </Button>
    </form>
  );
}
