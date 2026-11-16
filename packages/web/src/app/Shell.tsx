// The frame every view sits in (A5 3.3): the sidebar of views and areas, the top bar, the status
// bar for service problems, and the routed view. No border between the sidebar and the view:
// spacing separates them. Views have no heading; the active sidebar item and the tab's title name
// the view. Below 1,024 px the sidebar becomes a drawer behind a Menu button.
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useEdits } from "../edit/useEdits.ts";
import { useT } from "../i18n/intl.tsx";
import { ToastContext } from "./frame.ts";
import { Toast, type Shown, type ToastHandle } from "./Toast.tsx";
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
  "top",
]);

/** Whether a key goes to a text field, where the browser's own text undo applies (A5 3.12). */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(target.type)
  );
}

export function Shell({ space }: { readonly space: string }) {
  const t = useT();
  const state = useLive();
  const edits = useEdits();
  const [toast, setToast] = useState<Shown | undefined>(undefined);
  const toastHandle = useRef<ToastHandle | undefined>(undefined);
  const plain = useRef(0);
  const [drawer, setDrawer] = useState(false);
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

  // Undo and redo from the keyboard (A5 3.12), and F6 to the toast's action. A text field keeps
  // Ctrl+Z for its own text.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "F6" && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (toastHandle.current?.focusAction() === true) event.preventDefault();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void edits.undo();
      } else if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
        event.preventDefault();
        void edits.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [edits]);
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
      </div>
    </ToastContext.Provider>
  );
}
