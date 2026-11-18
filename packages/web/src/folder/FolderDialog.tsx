// A folder chosen for a project or a task, over the page: the chooser, what the folder is (its
// name and repository, or the project that has it), and Use this folder. A refusal is said in the
// dialog in the service's words, and the person's text stays to correct.
import { useContext, useId, useState, type SyntheticEvent } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classes } from "../app/css.ts";
import setup from "../app/Setup.module.css";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
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
 * What the folder in the field is: its name and repository, or the project that has it, unless
 * that is the project the folder is chosen for (`owner`).
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
  const exact = look?.text === text ? look.exact : undefined;
  if (exact === undefined) return null;
  return (
    <p className={sheet.note} data-part="folder-facts">
      {exact.project === undefined || exact.project.id === owner
        ? exact.repo === undefined
          ? t("folder.is", { name: exact.name ?? exact.folder })
          : t("folder.isRepo", { name: exact.name ?? exact.folder, repo: exact.repo })
        : t("folder.taken", { project: exact.project.name })}
    </p>
  );
}

export function FolderDialog({
  title,
  lead,
  start,
  onClose,
  onChoose,
  owner,
}: {
  readonly title: string;
  readonly lead?: string;
  /** The text the field starts with: the folder there is now, or empty. */
  readonly start: string;
  readonly onClose: () => void;
  /** Writes the folder: resolves when it is done, or rejects with the refusal. */
  readonly onChoose: (folder: string) => Promise<void>;
  /** The project the folder is chosen for: its own folder is no other project's. */
  readonly owner?: string;
}) {
  const t = useT();
  const { api } = useContext(Session);
  const leadId = useId();
  const [text, setText] = useState(start);
  const [look, setLook] = useState<FolderLook>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const folder = chosenFolder(text);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || folder === undefined) return;
    setBusy(true);
    setError(undefined);
    onChoose(folder).then(onClose, (failed: unknown) => {
      setError(refusalText(failed, t("folder.notSet")));
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
              <p id={leadId} className={sheet.lead}>
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
              <p className={sheet.error} role="alert">
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
