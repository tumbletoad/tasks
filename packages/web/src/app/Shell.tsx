// The frame every view sits in (A5 3.3): the sidebar of views and areas, the top bar, the status
// bar for service problems, and the routed view. No border between the sidebar and the view:
// spacing separates them. Views have no heading; the active sidebar item and the tab's title name
// the view. Below 1,024 px the sidebar becomes a drawer behind a Menu button.
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useEdits } from "../edit/useEdits.ts";
import { useT } from "../i18n/intl.tsx";
import { actionOf } from "../keys/keymap.ts";
import { Sheet, SheetContext } from "../keys/Sheet.tsx";
import { askField } from "./field.ts";
import { ToastContext } from "./frame.ts";
import { Toast, type Shown, type ToastHandle } from "./Toast.tsx";
import { MenuIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import { useMachine } from "./machine.ts";
import css from "./Shell.module.css";
import { Sidebar } from "./Sidebar.tsx";
import { Tips } from "./Tips.tsx";
import { TopBar } from "./TopBar.tsx";
import { classes } from "./css.ts";

const styles = classes(css, [
  "bar",
  "column",
  "drawer",
  "drawerBody",
  "frame",
  "line",
  "main",
  "menu",
  "overlay",
  "sidebar",
  "skip",
  "top",
]);

export function Shell({ space }: { readonly space: string }) {
  const t = useT();
  const state = useLive();
  const edits = useEdits();
  const [toast, setToast] = useState<Shown | undefined>(undefined);
  const toastHandle = useRef<ToastHandle | undefined>(undefined);
  const plain = useRef(0);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const { singleKeys } = useMachine();
  const sheetControl = useMemo(
    () => ({
      open: () => {
        setSheet(true);
      },
    }),
    [],
  );
  const path = useRouterState({ select: (s) => s.location.pathname });

  // A plain message from any component; the edits' toasts carry their own action.
  const say = useCallback((text: string) => {
    plain.current -= 1;
    setToast({ key: plain.current, kind: "info", text });
  }, []);
  useEffect(
    () =>
      edits.onToast((next) => {
        setToast(next);
      }),
    [edits],
  );
  const done = useCallback((key: number) => {
    setToast((shown) => (shown?.key === key ? undefined : shown));
  }, []);

  // The page's own keys (keymap.ts): undo and redo (a text field keeps Ctrl+Z for its own text),
  // F6 to the toast's action, a new task, search, and the sheet. A key a part of the page took
  // first (an editor, the list) is that part's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = actionOf(event, "page", singleKeys);
      if (action === "message") {
        if (toastHandle.current?.focusAction() === true) event.preventDefault();
        return;
      }
      if (action === "undo") void edits.undo();
      else if (action === "redo") void edits.redo();
      else if (action === "new") askField({ kind: "new" });
      else if (action === "search") askField({ kind: "search" });
      else if (action === "sheet") setSheet(true);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [edits, singleKeys]);
  // A link in the drawer navigates; the drawer closes behind it.
  useEffect(() => {
    setDrawer(false);
  }, [path]);

  let content: ReactNode;
  if (state.phase === "starting" || state.phase === "connecting") {
    content = <p className={styles.line}>{t("app.starting")}</p>;
  } else if (state.phase === "no_space") {
    content = <p className={styles.line}>{t("app.noSpace")}</p>;
  } else {
    content = <Outlet />;
  }

  return (
    <ToastContext.Provider value={say}>
      <SheetContext.Provider value={sheetControl}>
        <div className={styles.frame} data-phase={state.phase}>
          <a className={styles.skip} href="#main">
            {t("app.skip")}
          </a>
          <nav className={styles.sidebar} aria-label={t("nav.label")}>
            <Sidebar space={space} />
          </nav>
          <div className={styles.column}>
            <header className={styles.top}>
              <Button
                className={styles.menu}
                aria-label={t("nav.menu")}
                onPress={() => {
                  setDrawer(true);
                }}
              >
                <MenuIcon />
              </Button>
              <TopBar space={space} live={state.phase === "live" || state.phase === "offline"} />
            </header>
            {state.stale ? (
              <div className={styles.bar} role="status">
                <span>{t("app.updated")}</span>
                <button
                  type="button"
                  onClick={() => {
                    location.reload();
                  }}
                >
                  {t("app.reload")}
                </button>
              </div>
            ) : null}
            {/* A page of an older build is refused by the service, which runs: it is not offline. */}
            {state.phase === "offline" && !state.stale ? (
              <div className={styles.bar} data-tone="late" role="status">
                {t("app.offline")}
              </div>
            ) : null}
            {state.installed !== undefined && !state.stale ? (
              <div className={styles.bar} role="status" data-part="installed">
                {t("app.installed", {
                  version: state.installed.version,
                  running: state.installed.running,
                })}
              </div>
            ) : null}
            <main id="main" tabIndex={-1} className={styles.main}>
              {content}
            </main>
          </div>
          <ModalOverlay
            className={styles.overlay}
            isOpen={drawer}
            onOpenChange={setDrawer}
            isDismissable
          >
            <Modal className={styles.drawer}>
              <Dialog className={styles.drawerBody} aria-label={t("nav.label")}>
                <Sidebar space={space} />
              </Dialog>
            </Modal>
          </ModalOverlay>
          <Toast toast={toast} onDone={done} handle={toastHandle} />
          <Sheet space={space} isOpen={sheet} onOpenChange={setSheet} />
          <Tips />
        </div>
      </SheetContext.Provider>
    </ToastContext.Provider>
  );
}
