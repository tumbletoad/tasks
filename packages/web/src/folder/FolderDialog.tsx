// A folder chosen for a project or a task, over the page: the chooser, what the folder is (its
// name and repository, and the projects that have it too), and Use this folder. A refusal is said in the
// dialog in the service's words, and the person's text stays to correct.
import { useContext, useId, useState, type SyntheticEvent } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classes } from "../app/css.ts";
import setup from "../app/Setup.module.css";
import { Session } from "../context.ts";
import { useList, useT } from "../i18n/intl.tsx";
import { chosenFolder } from "./chooser.ts";
import { FolderField, type FolderLook } from "./FolderField.tsx";

const sheet = classes(setup, [
  "actions",
  "dialog",
  "error",
  "form",
  "lead",
  "modal",
  "note",
  "overlay",
  "primary",
  "quiet",
  "title",
]);

/** The service's sentence for a refusal (an error with its code), or the page's own words. */
export function refusalText(error: unknown, fallback: string): string {
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    const said = error.message;
    if (said !== "" && said.length <= 300) return said;
  }
  return fallback;
}

/**
 * A refusal because someone changed the folder after it was read: where the service found the
 * change, and the folder there now when it says.
 */
function changedSince(error: unknown): { asOf?: string; now?: string } | undefined {
  const { code, data } = (error ?? {}) as {
    code?: unknown;
    data?: { cause?: unknown; as_of?: unknown; conflicts?: { field?: unknown; value?: unknown }[] };
  };
  if (code !== "conflict" || data?.cause !== "VERSION_CONFLICT") return undefined;
  const now = data.conflicts?.find((c) => c.field === "path")?.value;
  return {
    ...(typeof data.as_of === "string" ? { asOf: data.as_of } : {}),
    ...(typeof now === "string" ? { now } : {}),
  };
}

/**
 * What the folder in the field is: its name and repository, and the other projects that have it,
 * but the one the folder is chosen for (`owner`).
 */
export function FolderFacts({
  look,
  text,
  owner,
}: {
  readonly look: FolderLook | undefined;
  readonly text: string;
  readonly owner?: string | undefined;
}) {
  const t = useT();
  const list = useList();
  const exact = look?.text === text ? look.exact : undefined;
  if (exact === undefined) return null;
  const others = (exact.projects ?? []).filter((p) => p.id !== owner).map((p) => p.name);
  return (
    <>
      <p className={sheet.note} data-part="folder-facts" data-machine="">
        {exact.repo === undefined
          ? t("folder.is", { name: exact.name ?? exact.folder })
          : t("folder.isRepo", { name: exact.name ?? exact.folder, repo: exact.repo })}
      </p>
      {others.length === 0 ? null : (
        <p className={sheet.note} data-part="folder-also">
          {t("folder.also", { projects: list(others) })}
        </p>
      )}
    </>
  );
}

export function FolderDialog({
  title,
  lead,
  start,
  base: read,
  onClose,
  onChoose,
  owner,
}: {
  readonly title: string;
  readonly lead?: string;
  /** The text the field starts with: the folder there is now, or empty. */
  readonly start: string;
  /** Where the feed was when `start` was read: by default, where it is when the dialog opens. */
  readonly base?: string | undefined;
  readonly onClose: () => void;
  /** Writes the folder with `base`: resolves when it is done, or rejects with the refusal. */
  readonly onChoose: (folder: string, base: string | undefined) => Promise<void>;
  /** The project the folder is chosen for: its own folder is no other project's. */
  readonly owner?: string;
}) {
  const t = useT();
  const { api, live } = useContext(Session);
  const leadId = useId();
  const [text, setText] = useState(start);
  const [look, setLook] = useState<FolderLook>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A folder set elsewhere since it was read is not replaced unseen: the first Use says what is
  // there now, and the next one replaces that.
  const [base, setBase] = useState(() => read ?? live.store.asOf);
  const folder = chosenFolder(text);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || folder === undefined) return;
    setBusy(true);
    setError(undefined);
    onChoose(folder, base).then(onClose, (failed: unknown) => {
      const changed = changedSince(failed);
      if (changed !== undefined) {
        setBase(changed.asOf ?? live.store.asOf);
        setError(
          changed.now === undefined
            ? t("folder.changedElsewhere")
            : t("folder.changedTo", { folder: changed.now }),
        );
      } else setError(refusalText(failed, t("folder.notSet")));
      setBusy(false);
    });
  };

  return (
    <ModalOverlay
      className={sheet.overlay}
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className={sheet.modal}>
        <Dialog className={sheet.dialog} aria-label={title}>
          <form className={sheet.form} onSubmit={submit} aria-busy={busy}>
            <Heading slot="title" level={2} className={sheet.title}>
              {title}
            </Heading>
            {lead === undefined ? null : (
              <p id={leadId} className={sheet.lead} data-machine="">
                {lead}
              </p>
            )}
            <FolderField
              api={api}
              label={t("folder.label")}
              value={text}
              onChange={(value) => {
                setText(value);
                setError(undefined);
              }}
              onLook={setLook}
              autoFocus
              {...(lead === undefined ? {} : { describedBy: leadId })}
            />
            <FolderFacts look={look} text={text} owner={owner} />
            {error === undefined ? null : (
              <p className={sheet.error} role="alert" data-machine="">
                {error}
              </p>
            )}
            <div className={sheet.actions}>
              <Button
                type="submit"
                className={sheet.primary}
                isDisabled={busy || folder === undefined}
              >
                {t("folder.use")}
              </Button>
              <Button className={sheet.quiet} onPress={onClose}>
                {t("folder.cancel")}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
