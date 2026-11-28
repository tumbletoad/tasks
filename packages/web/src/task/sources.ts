// A source as the row and the expanded task show it: its own text, never a label.
// "Wrong appointment times since Sunday · Ana Reyes" for a mail, "LUM-212 Appointments off by one
// hour" for a ticket, its key first. The words around the parts come from the catalogue.
import type { Translate } from "../i18n/intl.tsx";
import type { PlaceFact, SourceFact } from "../row/model.ts";
import type { RowPlace, RowSource } from "@ttasks/client/store";

/** A source's text: its key, its title and its person, as the catalogue joins them. */
export function sourceText(t: Translate, source: RowSource): string {
  const { title, who, ref } = source;
  if (ref !== undefined && who !== undefined) return t("source.refWho", { ref, title, who });
  if (ref !== undefined) return t("source.ref", { ref, title });
  if (who !== undefined) return t("source.who", { title, who });
  return title;
}

/** The row's source facts from the compact row's sources. */
export function sourceFacts(t: Translate, sources: readonly RowSource[] | undefined): SourceFact[] {
  return (sources ?? []).map((source) => ({
    kind: source.kind,
    text: sourceText(t, source),
    ...(source.url === undefined ? {} : { url: source.url }),
  }));
}

/** The row's folder fact from the compact row's place. */
export function placeFact(place: RowPlace | undefined): PlaceFact | undefined {
  switch (place?.state) {
    case undefined:
      return undefined;
    case "here":
      return { kind: "here" };
    case "missing":
      return { kind: "missing" };
    case "elsewhere":
      return { kind: "elsewhere", machine: place.machine };
  }
}
