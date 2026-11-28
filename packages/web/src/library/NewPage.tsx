// New page, beside a Library's pages: a title is all it asks. Enter makes the page and opens it
// with the pen in its body; Escape lets go. No dialog: the field stands where the button was.
import { useNavigate } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { PlusIcon } from "../app/Icons.tsx";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { Session } from "../context.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { useT } from "../i18n/intl.tsx";
import css from "./Library.module.css";
import { useLibraryWrites } from "./writes.ts";

const styles = classes(css, ["newPage", "newTitle"]);
const TITLE_MAX = 300;

export function NewPage({
  on,
  from,
}: {
  /** Where the page goes: a project's or an area's ID, or "space". */
  readonly on: string;
  /** Where the person is: the new page's way back. */
  readonly from: { readonly path: string; readonly label: string };
}) {
  const t = useT();
  const say = useToast();
  const navigate = useNavigate();
  const { live } = useContext(Session);
  const writes = useLibraryWrites();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className={styles.newPage}
        data-part="new-page"
        onClick={() => {
          setOpen(true);
        }}
      >
        <PlusIcon />
        {t("library.newPage")}
      </button>
    );
  }
  return (
    <input
      ref={(field) => {
        // The field is what the person just asked for.
        field?.focus();
      }}
      className={styles.newTitle}
      data-part="new-page-title"
      aria-label={t("library.newTitle")}
      placeholder={t("library.newTitle")}
      maxLength={TITLE_MAX}
      readOnly={sending}
      dir="auto"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        const title = event.currentTarget.value.trim();
        if (title === "" || sending) return;
        setSending(true);
        writes.create(on, title).then(
          (ref) => {
            setSending(false);
            setOpen(false);
            if (ref === "") return;
            void navigate({
              to: "/s/$space/page/$ref",
              params: { space: live.spaceId ?? "", ref },
              state: { from, pen: "body" },
            });
          },
          (error: unknown) => {
            setSending(false);
            if (!live.failed(error)) say(refusalText(error, t("page.notMade")));
          },
        );
      }}
    />
  );
}
