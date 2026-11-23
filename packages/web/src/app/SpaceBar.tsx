// What a tab says above its views about the copy of its space it shows, before the person acts: a
// restored copy, with its folder, the backup it came from and the ways out; why a space takes no
// change, in the service's words; and a copy closed or replaced since the tab loaded it, with the
// way to load what the space is now.
import { useT } from "../i18n/intl.tsx";
import type { Gone, LiveState } from "../store/store.ts";
import css from "./SpaceBar.module.css";
import { classes } from "./css.ts";

const styles = classes(css, ["bar", "line"]);

/**
 * The space as a command names it: its name, which means the one folder that serves it, quoted when
 * a shell would split it; its ID when no quoting is safe.
 */
function commandWord(name: string, id: string): string {
  if (/^[\p{L}\p{N}._-]+$/u.test(name)) return name;
  return /^[\p{L}\p{N} ._-]+$/u.test(name) ? `"${name}"` : id;
}

export function SpaceBar({ state }: { readonly state: LiveState }) {
  const t = useT();
  const head = state.space;
  if (head === undefined) return state.gone === undefined ? null : <NotLoaded gone={state.gone} />;
  const name = head.name;
  const folder = head.folder ?? "";
  if (state.gone !== undefined) {
    return (
      <div className={styles.bar} role="status" data-part="gone" dir="auto">
        <p className={styles.line}>
          {t("space.gone", { why: state.gone.why, name, folder: state.gone.folder ?? "" })}
        </p>
        <button
          type="button"
          onClick={() => {
            location.reload();
          }}
        >
          {t("space.goneLoad", { name })}
        </button>
      </div>
    );
  }
  const { restored, read_only: readOnly } = head;
  if (restored === undefined && readOnly === undefined) return null;
  // The service's words stand for the space's folder with `<folder>`: the page knows it.
  const why = readOnly?.message?.replaceAll("<folder>", folder);
  return (
    <div className={styles.bar} role="status" data-part="read-only" dir="auto">
      {restored === undefined ? null : (
        <p className={styles.line} data-part="restored">
          {t("space.restoredNote", {
            name,
            at: Date.parse(restored.at),
            backup: restored.backup ?? "none",
            folder,
            space: commandWord(name, head.id),
          })}
        </p>
      )}
      {readOnly === undefined ||
      (restored !== undefined && readOnly.reason === "read_only_copy") ? null : (
        <p className={styles.line} data-part="read-only-why">
          {why ?? t("space.readOnlyNote")}
        </p>
      )}
    </div>
  );
}

/**
 * A tab sent to the folder the person opened, whose space was closed, or is served from another
 * copy, before the tab loaded anything: it shows nothing of it.
 */
function NotLoaded({ gone }: { readonly gone: Gone }) {
  const t = useT();
  return (
    <div className={styles.bar} role="status" data-part="gone" dir="auto">
      <p className={styles.line}>
        {t("space.goneBeforeLoad", { why: gone.why === "closed" ? "closed" : "other" })}
      </p>
      <button
        type="button"
        onClick={() => {
          location.reload();
        }}
      >
        {t("space.goneBeforeLoadLoad")}
      </button>
    </div>
  );
}
