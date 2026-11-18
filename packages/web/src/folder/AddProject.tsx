// New project: choose its folder, see the name it gets (the folder's, changeable) and the
// repository a checkout holds, choose or name its area, done. A folder that is another project's
// already opens that project instead. A project without a folder is one click away.
import { useNavigate } from "@tanstack/react-router";
import { useContext, useId, useMemo, useState, type SyntheticEvent } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import setup from "../app/Setup.module.css";
import { Session } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import type { Live } from "../live.ts";
import { chosenFolder } from "./chooser.ts";
import { FolderFacts, refusalText } from "./FolderDialog.tsx";
import { FolderField, type FolderLook } from "./FolderField.tsx";
import { useFolderWrites } from "./writes.ts";

const sheet = classes(setup, [
  "actions",
  "dialog",
  "error",
  "field",
  "form",
  "input",
  "label",
  "lead",
  "modal",
  "note",
  "overlay",
  "primary",
  "quiet",
  "title",
]);

/** The choice of the area list that names a new area. */
const NEW_AREA = "";

/** How long the page waits for the feed to bring a new project before it stays where it is. */
const ARRIVE_MS = 10_000;

/** The project's area once the feed holds it, or undefined after `ARRIVE_MS`. */
function arrival(live: Live, project: string): Promise<string | undefined> {
  const area = () => live.getState().projects.get(project)?.area_id;
  if (area() !== undefined) return Promise.resolve(area());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(undefined);
    }, ARRIVE_MS);
    const stop = live.onChanges(() => {
      const found = area();
      if (found === undefined) return;
      clearTimeout(timer);
      stop();
      resolve(found);
    });
  });
}

export function AddProject({
  space,
  area: preset,
  onClose,
}: {
  readonly space: string;
  /** The area it goes in unless the person chooses another. */
  readonly area?: string | undefined;
  readonly onClose: () => void;
}) {
  const t = useT();
  const say = useToast();
  const navigate = useNavigate();
  const { api, live } = useContext(Session);
  const writes = useFolderWrites();
  const state = useLive();
  const nameId = useId();
  const areaId = useId();
  const areas = useMemo(
    () =>
      [...state.areas.values()].sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
      ),
    [state.areas],
  );
  const [text, setText] = useState("");
  const [look, setLook] = useState<FolderLook>();
  const [name, setName] = useState<string>();
  const [area, setArea] = useState(preset ?? areas[0]?.id ?? NEW_AREA);
  const [newArea, setNewArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const folder = chosenFolder(text);
  const exact = look?.text === text ? look.exact : undefined;
  const named = name ?? exact?.name ?? "";
  const areaName =
    area === NEW_AREA ? newArea.trim() : (state.areas.get(area)?.title ?? newArea.trim());

  const open = (project: string, areaOf: string | undefined) => {
    onClose();
    if (areaOf === undefined) return;
    void navigate({
      to: "/s/$space/area/$area/project/$project",
      params: { space, area: areaOf, project },
    });
  };

  const add = (withFolder: boolean) => {
    if (busy) return;
    if (withFolder && folder === undefined) return;
    if (areaName === "") {
      setError(t("project.needsArea"));
      return;
    }
    if (!withFolder && named.trim() === "") {
      setError(t("project.needsName"));
      return;
    }
    setBusy(true);
    setError(undefined);
    writes
      .addProject({
        ...(withFolder && folder !== undefined ? { folder } : {}),
        name: named,
        area: areaName,
      })
      .then(
        async (written) => {
          const project = written.project;
          if (project === undefined) {
            onClose();
            return;
          }
          if (written.result === "exists") say(t("project.exists", { project: project.name }));
          open(project.id, await arrival(live, project.id));
        },
        (failed: unknown) => {
          setError(refusalText(failed, t("project.notAdded")));
          setBusy(false);
        },
      );
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    add(true);
  };

  return (
    <ModalOverlay
      className={sheet.overlay}
      isOpen
      isDismissable
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Modal className={sheet.modal}>
        <Dialog className={sheet.dialog} aria-label={t("project.new")}>
          <form className={sheet.form} onSubmit={submit} aria-busy={busy}>
            <Heading slot="title" level={2} className={sheet.title}>
              {t("project.new")}
            </Heading>
            <p className={sheet.lead}>{t("project.lead")}</p>
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
            />
            {exact?.project === undefined ? (
              <FolderFacts look={look} text={text} />
            ) : (
              <p className={sheet.note} data-part="folder-facts">
                {t("folder.taken", { project: exact.project.name })}
                <Button
                  className={sheet.quiet}
                  onPress={() => {
                    const project = exact.project;
                    if (project !== undefined) {
                      open(project.id, live.getState().projects.get(project.id)?.area_id);
                    }
                  }}
                >
                  {t("project.open", { project: exact.project.name })}
                </Button>
              </p>
            )}
            <div className={sheet.field}>
              <label className={sheet.label} htmlFor={nameId}>
                {t("project.name")}
              </label>
              <input
                id={nameId}
                type="text"
                className={sheet.input}
                value={named}
                maxLength={120}
                placeholder={t("project.namePlaceholder")}
                dir="auto"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <div className={sheet.field}>
              <label className={sheet.label} htmlFor={areaId}>
                {t("project.area")}
              </label>
              {areas.length === 0 ? null : (
                <select
                  id={areaId}
                  className={sheet.input}
                  value={area}
                  onChange={(event) => {
                    setArea(event.target.value);
                    setError(undefined);
                  }}
                >
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                  <option value={NEW_AREA}>{t("project.newArea")}</option>
                </select>
              )}
              {area === NEW_AREA || areas.length === 0 ? (
                <input
                  type="text"
                  className={sheet.input}
                  value={newArea}
                  maxLength={120}
                  {...(areas.length === 0
                    ? { id: areaId }
                    : { "aria-label": t("project.newAreaName") })}
                  placeholder={t("project.areaPlaceholder")}
                  dir="auto"
                  onChange={(event) => {
                    setNewArea(event.target.value);
                    setError(undefined);
                  }}
                />
              ) : null}
            </div>
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
                {t("project.add")}
              </Button>
              <Button
                className={sheet.quiet}
                isDisabled={busy}
                onPress={() => {
                  add(false);
                }}
              >
                {t("project.noFolder")}
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
