// New project: choose its folder, see the name it gets (the folder's, changeable), the repository
// a checkout holds and the projects that have the folder too, choose or name its area, done. A
// project of that name in that area that has the folder already opens instead. A project without a
// folder is one click away. Where the project went is what the service's answer says: a name can
// resolve to an archived area in ways the dialog does not foresee, and an area can be archived
// before the write lands.
import { useNavigate } from "@tanstack/react-router";
import { useContext, useId, useMemo, useState, type SyntheticEvent } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classes } from "../app/css.ts";
import { useUnarchive } from "../app/Archived.tsx";
import { useToast } from "../app/frame.ts";
import setup from "../app/Setup.module.css";
import { Session } from "../context.ts";
import { liveGroups } from "@ttasks/client/today";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import { sameName } from "../task/areaNames.ts";
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
  // An archived area takes no new project: it is not offered, also when the page on screen is its.
  const areas = useMemo(
    () =>
      liveGroups(state.areas.values(), []).areas.sort((a, b) =>
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
  const unarchive = useUnarchive();

  const folder = chosenFolder(text);
  const exact = look?.text === text ? look.exact : undefined;
  const named = name ?? exact?.name ?? "";
  // The area the list shows is the one the project goes in: the one chosen while it is live, else
  // the first live one. The request names it by its ID, so no other area of its name is meant.
  const shown =
    area === NEW_AREA || areas.some((a) => a.id === area) ? area : (areas[0]?.id ?? NEW_AREA);
  const typed = newArea.trim();
  const sent = shown === NEW_AREA ? typed : shown;
  // A new area's name that an archived area has would put the project in that area, out of sight:
  // the dialog says so before the click. The answer of the write says it for every other way.
  const shelved =
    shown !== NEW_AREA || typed === "" || areas.some((a) => sameName(a.title, typed))
      ? undefined
      : [...state.areas.values()].find(
          (a) => a.lifecycle === "archived" && sameName(a.title, typed),
        );

  const open = (project: string, areaOf: string | undefined) => {
    onClose();
    if (areaOf === undefined) return;
    void navigate({
      to: "/s/$space/area/$area/project/$project",
      params: { space, area: areaOf, project },
    });
  };

  const add = (withFolder: boolean) => {
    if (busy || shelved !== undefined) return;
    if (withFolder && folder === undefined) return;
    if (sent === "") {
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
        area: sent,
        told: (exact?.projects?.length ?? 0) > 0,
      })
      .then(
        async (written) => {
          const project = written.project;
          if (project === undefined) {
            onClose();
            return;
          }
          const area = written.area;
          if (written.result === "exists") say(t("project.exists", { project: project.name }));
          else if (area?.archived === true) {
            // The edit history keeps the add: Ctrl+Z still takes it back.
            say(t("toast.projectAddedArchived", { name: project.name, area: area.name }), {
              label: { id: "archived.unarchiveArea", values: { area: area.name } },
              run: () => {
                void unarchive({ id: area.id, title: area.name });
              },
            });
          }
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
            <FolderFacts look={look} text={text} />
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
                  value={shown}
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
              {shown === NEW_AREA ? (
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
              {shelved === undefined ? null : (
                <p className={sheet.note} data-part="area-archived" role="status">
                  {t("project.areaArchived", { area: shelved.title })}
                  <Button
                    className={sheet.quiet}
                    isDisabled={busy}
                    onPress={() => {
                      setBusy(true);
                      void unarchive(shelved).then((back) => {
                        setBusy(false);
                        if (!back) return;
                        setArea(shelved.id);
                        setNewArea("");
                      });
                    }}
                  >
                    {t("archived.unarchiveArea", { area: shelved.title })}
                  </Button>
                </p>
              )}
            </div>
            {error === undefined ? null : (
              <p className={sheet.error} role="alert" data-machine="">
                {error}
              </p>
            )}
            <div className={sheet.actions}>
              <Button
                type="submit"
                className={sheet.primary}
                isDisabled={busy || shelved !== undefined || folder === undefined}
              >
                {t("project.add")}
              </Button>
              <Button
                className={sheet.quiet}
                isDisabled={busy || shelved !== undefined}
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
