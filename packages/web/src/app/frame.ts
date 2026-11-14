// What the frame gives the components inside it: the toast, and the tab's title.
import { createContext, useContext, useEffect } from "react";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";

/** A short, polite message at the foot of the page. */
export const ToastContext = createContext<(text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

/** Names the view in the tab's title (U3): "<view> · <space>". */
export function useTitle(view: string): void {
  const t = useT();
  const name = useLive().space?.name;
  useEffect(() => {
    if (name !== undefined) document.title = t("app.title", { view, space: name });
  }, [t, view, name]);
}
