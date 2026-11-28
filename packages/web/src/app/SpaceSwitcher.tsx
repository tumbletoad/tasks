// The space switcher (A5 3.3): the space's name and a chevron, which open a small popover with the
// spaces on this machine. Choosing one navigates this tab only: its route takes the new space, the
// tab takes a fresh snapshot and moves its feed to it, and every other tab keeps its own space,
// view, feed and drafts. Each space has Make default, and the machine's default carries a mark.
// The default decides only what a new tab (`/`) and an unbound CLI call open.
//
// A space whose backups are not working (its daily backup failed, or the newest one does not
// restore) has a quiet mark on the trigger and a note in the popover that says what to run. The
// list is read when the switcher appears, each time it opens, when the tab is shown again and every
// few minutes while it is shown, so the mark comes and goes with the backups.
//
// A restored copy is marked as one, with its folder, whatever else keeps it read-only.
//
// New space and Open folder open the same form as the first start, over the page; the space it
// makes or opens is where the tab goes next. A folder whose space is open from another folder is
// refused there with the service's words: what is open, what the folder is, what to do.
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, DialogTrigger, Modal, ModalOverlay, Popover } from "react-aria-components";
import { SignedOut } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import { useToast } from "./frame.ts";
import { CheckIcon, ChevronIcon } from "./Icons.tsx";
import { useAuth, useMachineApi } from "./session.tsx";
import { NotOpenNotes } from "./NotOpen.tsx";
import { openedFor } from "./opened.ts";
import { SpaceForm, type SpaceFormMode } from "./SpaceForm.tsx";
import setup from "./Setup.module.css";
import {
  backupTrouble,
  isServed,
  listSpaces,
  makeDefault,
  notOpen,
  type SpaceList,
} from "./spaces.ts";
import css from "./SpaceSwitcher.module.css";
import { LANDING } from "@ttasks/client/today";
import { classes } from "./css.ts";

const styles = classes(css, [
  "attention",
  "default",
  "dialog",
  "make",
  "mark",
  "name",
  "note",
  "pick",
  "popover",
  "space",
  "spaces",
  "state",
  "title",
  "trigger",
  "add",
  "adds",
  "where",
]);
const sheet = classes(setup, ["dialog", "modal", "overlay"]);

const RELIST_MS = 5 * 60_000;

export function SpaceSwitcher({
  space,
  name,
}: {
  readonly space: string;
  readonly name: string | undefined;
}) {
  const t = useT();
  const api = useMachineApi();
  const auth = useAuth();
  const say = useToast();
  const [list, setList] = useState<SpaceList | "failed" | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<SpaceFormMode | undefined>(undefined);
  const navigate = useNavigate();

  const failed = useCallback(
    (error: unknown): boolean => {
      if (error instanceof SignedOut) {
        auth.signedOut();
        return true;
      }
      return false;
    },
    [auth],
  );

  const load = useCallback(() => {
    listSpaces(api).then(setList, (error: unknown) => {
      if (!failed(error)) setList("failed");
    });
  }, [api, failed]);

  // A page left open for days still learns when a daily backup fails or works again.
  useEffect(() => {
    load();
    const visible = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = setInterval(visible, RELIST_MS);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const troubles = list === undefined || list === "failed" ? [] : backupTrouble(list);
  const attention =
    list !== undefined &&
    list !== "failed" &&
    list.spaces.some(
      (item) => item.id === space && item.state === "open" && item.backup !== undefined,
    );

  const make = (id: string, title: string) => {
    setBusy(id);
    makeDefault(api, id)
      .then(
        () => {
          say(t("space.madeDefault", { name: title }));
          load();
        },
        (error: unknown) => {
          if (!failed(error)) say(t("space.defaultFailed"));
        },
      )
      .finally(() => {
        setBusy(undefined);
      });
  };

  return (
    <>
      <DialogTrigger
        onOpenChange={(open) => {
          if (open) load();
        }}
      >
        <Button
          className={styles.trigger}
          aria-label={t(attention ? "space.switchBackup" : "space.switch", { name: name ?? "" })}
        >
          <span className={styles.name} dir="auto">
            {name ?? ""}
          </span>
          {attention ? <span className={styles.attention} data-part="backup-attention" /> : null}
          <ChevronIcon />
        </Button>
        <Popover className={styles.popover} placement="bottom start" offset={4}>
          <Dialog className={styles.dialog} aria-label={t("space.list")}>
            {({ close }) =>
              list === "failed" ? (
                <p className={styles.note}>{t("space.listFailed")}</p>
              ) : (
                <>
                  <ul className={styles.spaces}>
                    {(list?.spaces ?? []).map((item) => {
                      const current = item.id === space;
                      const isDefault = list?.default === item.id;
                      const served = isServed(item);
                      return (
                        <li key={item.id} className={styles.space}>
                          {served ? (
                            <Link
                              to="/s/$space/$view"
                              params={{ space: item.id, view: LANDING }}
                              className={styles.pick}
                              {...(current ? { "aria-current": "page" as const } : {})}
                              onClick={close}
                            >
                              <span className={styles.mark}>{current ? <CheckIcon /> : null}</span>
                              <span className={styles.title} dir="auto">
                                {item.name}
                              </span>
                              {item.restored !== undefined ? (
                                <span className={styles.state} data-part="restored-copy">
                                  {t("space.restoredCopy")}
                                </span>
                              ) : item.state === "read_only" ? (
                                <span className={styles.state}>{t("space.readOnly")}</span>
                              ) : null}
                            </Link>
                          ) : (
                            <span className={styles.pick} data-disabled="true">
                              <span className={styles.mark} />
                              <span className={styles.title} dir="auto">
                                {item.name}
                              </span>
                              <span className={styles.state}>{t("space.unavailable")}</span>
                            </span>
                          )}
                          {isDefault ? (
                            <span className={styles.default}>{t("space.default")}</span>
                          ) : (
                            <Button
                              className={styles.make}
                              isDisabled={busy !== undefined}
                              aria-label={t("space.makeDefaultFor", { name: item.name })}
                              onPress={() => {
                                make(item.id, item.name);
                              }}
                            >
                              {t("space.makeDefault")}
                            </Button>
                          )}
                          {item.restored === undefined ? null : (
                            <span className={styles.where} data-machine="" dir="auto">
                              {t("space.restoredIn", {
                                at: Date.parse(item.restored.at),
                                folder: item.folder ?? "",
                              })}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {list === undefined ? null : (
                    <NotOpenNotes spaces={notOpen(list)} className={styles.note} />
                  )}
                  {troubles.map((trouble) => (
                    <p
                      key={trouble.id}
                      className={styles.note}
                      data-part="backup-trouble"
                      data-why={trouble.why}
                      dir="auto"
                    >
                      {t("space.backupTrouble", { name: trouble.name, why: trouble.why })}
                    </p>
                  ))}
                  <div className={styles.adds}>
                    {(["new", "open"] as const).map((mode) => (
                      <Button
                        key={mode}
                        className={styles.add}
                        onPress={() => {
                          close();
                          setAdding(mode);
                        }}
                      >
                        {t(mode === "new" ? "space.new" : "space.openFolder")}
                      </Button>
                    ))}
                  </div>
                </>
              )
            }
          </Dialog>
        </Popover>
      </DialogTrigger>
      <ModalOverlay
        className={sheet.overlay}
        isOpen={adding !== undefined}
        onOpenChange={(open) => {
          if (!open) setAdding(undefined);
        }}
        isDismissable
      >
        <Modal className={sheet.modal}>
          <Dialog
            className={sheet.dialog}
            aria-label={t(adding === "open" ? "start.openTitle" : "start.title")}
          >
            <SpaceForm
              mode={adding ?? "new"}
              headingLevel={2}
              onMode={setAdding}
              onMade={(made) => {
                setAdding(undefined);
                if (made.notRemembered !== undefined) say(made.notRemembered);
                openedFor(made.id, made.copy);
                // A folder of the tab's own space (its copy opened after the space was closed):
                // the tab loads it afresh, as the session it had was of the copy that closed.
                if (made.id === space) {
                  location.assign(`/s/${encodeURIComponent(made.id)}/${LANDING}`);
                  return;
                }
                void navigate({ to: "/s/$space/$view", params: { space: made.id, view: LANDING } });
              }}
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
