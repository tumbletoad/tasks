// A key as the page names it: on the sheet, in a hint and in Settings. Cmd on a Mac, Ctrl
// elsewhere; arrows as arrows; a character as typed.
import { useCallback, useMemo } from "react";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { isMac, type Binding } from "./keymap.ts";

const NAMED: Readonly<Record<string, MessageId>> = {
  Escape: "key.escape",
  Enter: "key.enter",
  Tab: "key.tab",
  Home: "key.home",
  End: "key.end",
  ArrowUp: "key.up",
  ArrowDown: "key.down",
  ArrowLeft: "key.left",
  ArrowRight: "key.right",
  " ": "key.space",
};

/** The caps of one binding, in the order they are pressed: `["Ctrl", "Shift", "Z"]`. */
export function useKeyCaps(): (binding: Binding) => string[] {
  const t = useT();
  const mac = useMemo(isMac, []);
  return useCallback(
    (binding: Binding) => {
      const named = NAMED[binding.key];
      return [
        ...(binding.mod === true ? [t(mac ? "key.cmd" : "key.ctrl")] : []),
        ...(binding.shift === true ? [t("key.shift")] : []),
        named === undefined
          ? binding.mod === true
            ? binding.key.toUpperCase()
            : binding.key
          : t(named),
      ];
    },
    [t, mac],
  );
}

/** One binding as one short text: `Ctrl K`. */
export function useKeyLabel(): (binding: Binding) => string {
  const caps = useKeyCaps();
  return useCallback((binding: Binding) => caps(binding).join(" "), [caps]);
}
