// The spaces a person cannot open now, each with what happened and what to run. A computer whose
// only space needs recovery must never read as a computer without a space.
import { useT } from "../i18n/intl.tsx";
import type { NotOpen } from "./spaces.ts";

export function NotOpenNotes({
  spaces,
  className,
}: {
  readonly spaces: readonly NotOpen[];
  readonly className: string;
}) {
  const t = useT();
  return spaces.map((space, i) => {
    const way = t("space.way", { why: space.why });
    return (
      <p key={i} className={className} data-part="not-open" data-why={space.why} dir="auto">
        {space.name === undefined
          ? t("space.unnamedNotOpen", { way })
          : t("space.notOpen", { name: space.name, way })}
      </p>
    );
  });
}
