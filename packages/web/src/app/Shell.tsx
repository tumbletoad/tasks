// The frame every view sits in (A5 3.3): the sidebar of views and areas, the top bar, the status
// bar for service problems, and the routed view. No border between the sidebar and the view:
// spacing separates them. Views have no heading; the active sidebar item and the tab's title name
// the view. Below 1,024 px the sidebar becomes a drawer behind a Menu button.
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useT } from "../i18n/intl.tsx";
import { ToastContext } from "./frame.ts";
import { MenuIcon } from "./Icons.tsx";
import { useLive } from "../store/hooks.ts";
import css from "./Shell.module.css";
import { Sidebar } from "./Sidebar.tsx";
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
  "toast",
  "top",
]);

const TOAST_MS = 2_500;

export function Shell({ space }: { readonly space: string }) {
  const t = useT();
  const state = useLive();
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [drawer, setDrawer] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });

  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setToast("");
    }, TOAST_MS);
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
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
          {state.phase === "offline" ? (
            <div className={styles.bar} data-tone="late" role="status">
              {t("app.offline")}
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
        <div className={styles.toast} role="status" aria-live="polite">
          {toast}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
