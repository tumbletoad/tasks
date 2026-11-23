// Formats a row model's messages (model.ts) with the page's catalogue: a value that is itself a
// message (a full date inside "Due {date}") is formatted first, so no words are joined by hand.
import type { Translate } from "../i18n/intl.tsx";
import type { Msg } from "./model.ts";

export function sayMsg(t: Translate, message: Msg): string {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.values ?? {})) {
    values[name] = typeof value === "object" ? sayMsg(t, value) : value;
  }
  return t(message.id, values);
}

/** The values that name a folder, a file or a machine. */
const MACHINE_VALUES: ReadonlySet<string> = new Set(["folder", "file", "backup", "machine"]);

/** Whether the message names a folder, a file or a machine: the page marks it `data-machine`. */
export function namesMachine(message: Msg): boolean {
  return Object.entries(message.values ?? {}).some(
    ([name, value]) =>
      MACHINE_VALUES.has(name) || (typeof value === "object" && namesMachine(value)),
  );
}
