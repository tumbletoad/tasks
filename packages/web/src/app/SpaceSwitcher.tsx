// The space switcher (A5 3.3): the space's name and a chevron, which open a small popover with the
// spaces on this machine. Choosing one navigates this tab only: its route takes the new space, the
// tab takes a fresh snapshot and moves its feed to it, and every other tab keeps its own space,
// view, feed and drafts. Each space has Make default, and the machine's default carries a mark.
// The default decides only what a new tab (`/`) and an unbound CLI call open.
//
// Each copy of a space is a row of its own: a restored copy beside its original says that it is
// one, and leads to that copy only. The trigger says it too, while the tab shows a read-only copy.
//
// A space whose backups are not working (its daily backup failed, or the newest one does not
// restore) has a quiet mark on the trigger and a note in the popover that says what to run. The
// list is read when the switcher appears, each time it opens, when the tab is shown again and every
// few minutes while it is shown, so the mark comes and goes with the backups.
//
// New space and Open folder open the same form as the first start, over the page; the space it
// makes or opens is where the tab goes next.
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, DialogTrigger, Modal, ModalOverlay, Popover } from "react-aria-components";
import { SignedOut } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import { useToast } from "./frame.ts";
import { CheckIcon, ChevronIcon } from "./Icons.tsx";
import type { ReadOnly } from "../store/rows.ts";
import { useAuth, useMachineApi } from "./session.tsx";
import { NotOpenNotes } from "./NotOpen.tsx";
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
import { LANDING } from "./views.ts";
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
]);
const sheet = classes(setup, ["dialog", "modal", "overlay"]);

const RELIST_MS = 5 * 60_000;

/** What a row and the trigger say of a copy that takes no change. */
const stateWords = (state: string, reason: string | undefined) =>
  state !== "read_only"
    ? undefined
    : reason === "read_only_copy"
      ? "space.restoredCopy"
      : "space.readOnly";

export function SpaceSwitcher({
  space,
  name,
  readOnly,
}: {
  /** The tab's route: the space's ID, or one copy's address. */
  readonly space: string;
  readonly name: string | undefined;
  readonly readOnly?: ReadOnly | undefined;
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
      (item) => item.address === space && item.state === "open" && item.backup !== undefined,
    );
  const shownState = readOnly === undefined ? undefined : stateWords("read_only", readOnly.reason);

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
          aria-label={t(attention ? "space.switchBackup" : "space.switch", {
            name:
              shownState === undefined
                ? (name ?? "")
                : t("space.nameState", { name: name ?? "", state: t(shownState) }),
          })}
        >
          <span className={styles.name} dir="auto">
            {name ?? ""}
          </span>
          {shownState === undefined ? null : (
            <span className={styles.state} data-part="space-state">
              {t(shownState)}
            </span>
          )}
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
                      const current = item.address === space;
                      // The default names a space by its ID: the copy that ID means.
                      const own = item.address === item.id;
                      const isDefault = own && list?.default === item.id;
                      const served = isServed(item);
                      const words = stateWords(item.state, item.reason);
                      return (
                        <li key={item.address} className={styles.space}>
                          {served ? (
                            <Link
                              to="/s/$space/$view"
                              params={{ space: item.address, view: LANDING }}
                              className={styles.pick}
                              {...(current ? { "aria-current": "page" as const } : {})}
                              onClick={close}
                            >
                              <span className={styles.mark}>{current ? <CheckIcon /> : null}</span>
                              <span className={styles.title} dir="auto">
                                {item.name}
                              </span>
                              {words === undefined ? null : (
                                <span className={styles.state}>{t(words)}</span>
                              )}
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
                          ) : !own ? null : (
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
                void navigate({
                  to: "/s/$space/$view",
                  params: { space: made.address, view: LANDING },
                });
              }}
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
