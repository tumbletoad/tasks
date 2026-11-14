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
