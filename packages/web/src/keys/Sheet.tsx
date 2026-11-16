// The shortcut sheet: every key that works in the view on screen, read from the keymap the
// handlers use. `?` opens it, and Settings' "Show every key". Single keys that are turned off are
// not listed, and the sheet says where to turn them on.
import { Link, useRouterState } from "@tanstack/react-router";
import { createContext, Fragment, useContext } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { useMachine } from "../app/machine.ts";
import { classes } from "../app/css.ts";
import { actionsIn, type KeyScope } from "./keymap.ts";
import { useKeyCaps } from "./labels.ts";
import css from "./Sheet.module.css";

const styles = classes(css, [
  "body",
  "caps",
  "group",
  "heading",
  "keys",
  "list",
  "note",
  "overlay",
  "sheet",
  "title",
]);

export const SheetContext = createContext<{ readonly open: () => void }>({
  open: () => undefined,
});

export const useSheet = () => useContext(SheetContext);

const HEADINGS: Readonly<Record<KeyScope, MessageId>> = {
  page: "keys.anywhere",
  list: "keys.inList",
  strip: "keys.inStrip",
  field: "keys.inField",
};

/** The parts of the view a path shows: Settings has no list, Today has the week strip too. */
export function scopesOf(path: string): KeyScope[] {
  const rest = /^\/s\/[^/]+(\/.*)?$/.exec(path)?.[1] ?? "";
  if (/^\/settings(?:\/|$)/.test(rest)) return ["page", "field"];
  if (rest === "" || rest === "/" || /^\/today\/?$/.test(rest)) {
    return ["page", "list", "strip", "field"];
  }
  return ["page", "list", "field"];
}

export function Sheet({
  space,
  isOpen,
  onOpenChange,
}: {
  readonly space: string;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const caps = useKeyCaps();
  const { singleKeys } = useMachine();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const scopes = scopesOf(path);
  const actions = actionsIn(scopes, singleKeys);
  return (
    <ModalOverlay
      className={styles.overlay}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
    >
      <Modal className={styles.sheet}>
        <Dialog className={styles.body} aria-labelledby="keys-title">
          <Heading slot="title" id="keys-title" className={styles.title}>
            {t("keys.sheet")}
          </Heading>
          {singleKeys ? null : (
            <p className={styles.note}>
              {t("keys.off")}
              <Link
                to="/s/$space/settings"
                params={{ space }}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t("keys.turnOn")}
              </Link>
            </p>
          )}
          {scopes.map((scope) => {
            const here = actions.filter((action) => action.scope === scope);
            if (here.length === 0) return null;
            return (
              <section key={scope} className={styles.group} aria-labelledby={`keys-${scope}`}>
                <Heading level={3} id={`keys-${scope}`} className={styles.heading}>
                  {t(HEADINGS[scope])}
                </Heading>
                <dl className={styles.list} data-scope={scope}>
                  {here.map((action) => (
                    <Fragment key={action.id}>
                      <dt className={styles.keys} data-action={action.id}>
                        {action.keys.map((binding, i) => (
                          <Fragment key={`${binding.key}:${String(i)}`}>
                            {i === 0 ? null : <span className={styles.note}>{t("keys.or")}</span>}
                            <span className={styles.caps}>
                              {caps(binding).map((cap) => (
                                <kbd key={cap}>{cap}</kbd>
                              ))}
                            </span>
                          </Fragment>
                        ))}
                      </dt>
                      <dd>{t(action.label)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            );
          })}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
