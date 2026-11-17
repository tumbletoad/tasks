// What the frame gives the components inside it: the toast, and the tab's title.
import { createContext, useContext, useEffect } from "react";
import { useT } from "../i18n/intl.tsx";
import type { Msg } from "../row/model.ts";
import { useLive } from "../store/hooks.ts";

/** What a toast's one action does, and its label. */
export interface ToastAction {
  readonly label: Msg;
  readonly run: () => void;
}

/**
 * A short, polite message at the foot of the page. One with an action asks something, so it stays
 * until it is answered or dismissed.
 */
export const ToastContext = createContext<(text: string, action?: ToastAction) => void>(
  () => undefined,
);
export const useToast = () => useContext(ToastContext);

/** Names the view in the tab's title (U3): "<view> · <space>". */
export function useTitle(view: string): void {
  const t = useT();
  const name = useLive().space?.name;
  useEffect(() => {
    if (name !== undefined) document.title = t("app.title", { view, space: name });
  }, [t, view, name]);
}
