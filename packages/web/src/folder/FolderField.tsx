// The folder chooser, one field used wherever a folder is chosen: a path typed or pasted (with `~`
// for the home) completes as it is typed, and the folders under it are listed for a person who
// would rather click. The list keeps one height whatever it holds, so nothing below it moves.
// The browser cannot see the disk: the service lists folders by name for the signed-in person.
// The arrow keys move through the list, Enter opens the folder chosen in it, and Enter with no
// choice in the list leaves the field's folder to the form.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "react-aria-components";
import type { Api, ExactFolder, FolderListing } from "../api.ts";
import { classes } from "../app/css.ts";
import { useT } from "../i18n/intl.tsx";
import { FolderIcon } from "../row/icons.tsx";
import { Latest } from "../latest.ts";
import { choicesOf, type Choice } from "./chooser.ts";
import css from "./Folder.module.css";

const styles = classes(css, [
  "browse",
  "choice",
  "field",
  "icon",
  "input",
  "label",
  "list",
  "mark",
  "name",
  "note",
  "up",
  "where",
]);

/** How long typing rests before the folders are listed again. */
const LIST_MS = 120;

/** What the chooser knows of the folder in the field, for the form around it. */
export interface FolderLook {
  /** The text the listing was for. */
  readonly text: string;
  /** The folder the text names, when it is one. */
  readonly exact?: ExactFolder;
  /** Why the folder the text is in cannot be listed. */
  readonly problem?: string;
}

export function FolderField({
  api,
  label,
  value,
  onChange,
  onLook,
  make = true,
  autoFocus = false,
  placeholder,
  describedBy,
}: {
  readonly api: Pick<Api, "folders" | "makeFolder">;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onLook?: (look: FolderLook) => void;
  /** Offer to make the folder whose name was typed. */
  readonly make?: boolean;
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
  readonly describedBy?: string;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState<FolderListing | undefined>();
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState<number | undefined>();
  const [making, setMaking] = useState(false);
  const reads = useRef(new Latest());
  const looked = useRef(onLook);
  looked.current = onLook;

  useEffect(() => {
    const newest = reads.current.begin("list");
    const timer = setTimeout(
      () => {
        api.folders(value).then(
          (found) => {
            if (!newest()) return;
            setListing(found);
            setFailed(false);
            setActive(undefined);
            looked.current?.({
              text: value,
              ...(found.kind === "list" && found.exact !== undefined ? { exact: found.exact } : {}),
              ...(found.kind === "problem" ? { problem: found.reason } : {}),
            });
          },
          () => {
            if (!newest()) return;
            setFailed(true);
            looked.current?.({ text: value, problem: "failed" });
          },
        );
      },
      value === "" ? 0 : LIST_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [api, value]);

  const choices = choicesOf(listing, make);
  const choose = (choice: Choice) => {
    // The choices are the old folder's until the new listing comes: none of them is chosen.
    setActive(undefined);
    if (choice.kind !== "make") {
      onChange(choice.value);
      input.current?.focus();
      return;
    }
    setMaking(true);
    api
      .makeFolder(choice.value)
      .then(
        (made) => {
          if (made.folder !== undefined) onChange(made.folder);
          else setListing({ kind: "problem", sep: listing?.sep ?? "/", reason: made.reason ?? "" });
        },
        () => {
          setFailed(true);
        },
      )
      .finally(() => {
        setMaking(false);
        input.current?.focus();
      });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (choices.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) =>
        at === undefined
          ? step === 1
            ? 0
            : choices.length - 1
          : (at + step + choices.length) % choices.length,
      );
      return;
    }
    if (event.key === "Enter" && active !== undefined) {
      const choice = choices[active];
      if (choice === undefined) return;
      event.preventDefault();
      choose(choice);
      return;
    }
    if (event.key === "Escape" && active !== undefined) {
      // The first Escape leaves the list; the next one is the form's.
      event.preventDefault();
      event.stopPropagation();
      setActive(undefined);
    }
  };

  const listId = `${id}-list`;
  const noteId = `${id}-note`;
  const at = listing?.kind === "list" || listing?.kind === "problem" ? listing.at : undefined;
  const up = listing?.kind === "list" ? listing.up : undefined;
  const note = failed
    ? t("folder.failed")
    : listing?.kind === "problem"
      ? t("folder.problem", { reason: listing.reason })
      : listing?.kind === "list" && listing.more
        ? t("folder.more")
        : listing?.kind === "list" && choices.length === 0
          ? t(listing.prefix === "" ? "folder.empty" : "folder.none")
          : listing?.kind === "start"
            ? t("folder.start")
            : "";

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listId}
        aria-describedby={[noteId, describedBy].filter((x) => x !== undefined).join(" ")}
        {...(active === undefined ? {} : { "aria-activedescendant": `${id}-c${String(active)}` })}
        className={styles.input}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder ?? t("folder.placeholder")}
        dir="ltr"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKey}
      />
      <div className={styles.browse} data-part="folder-browser" aria-busy={making}>
        <div className={styles.where}>
          {up === undefined ? null : (
            <Button
              className={styles.up}
              excludeFromTabOrder
              aria-label={t("folder.up", { folder: up })}
              onPress={() => {
                onChange(up);
                input.current?.focus();
              }}
            >
              {t("folder.upShort")}
            </Button>
          )}
          <span className={styles.name} dir="ltr">
            {at ?? t("folder.startHere")}
          </span>
        </div>
        <ul id={listId} role="listbox" aria-label={t("folder.choices")} className={styles.list}>
          {choices.map((choice, k) => (
            <li
              key={choice.key}
              id={`${id}-c${String(k)}`}
              role="option"
              aria-selected={k === active}
              className={styles.choice}
              data-kind={choice.kind}
              data-active={k === active || undefined}
              onMouseDown={(event) => {
                // The field keeps the focus: the choice is made, and typing goes on.
                event.preventDefault();
              }}
              onClick={() => {
                choose(choice);
              }}
            >
              <span className={styles.icon} aria-hidden="true">
                <FolderIcon />
              </span>
              <span className={styles.name} dir="auto">
                {choice.kind === "make"
                  ? t("folder.make", { name: choice.label })
                  : choice.kind === "home"
                    ? t("folder.home")
                    : choice.label}
              </span>
              {choice.link === undefined ? null : (
                <span className={styles.mark}>{t("folder.link")}</span>
              )}
              {choice.project === undefined ? null : (
                <span className={styles.mark} dir="auto">
                  {typeof choice.project === "string"
                    ? t("folder.near", { project: choice.project })
                    : t("folder.project", { project: choice.project.name })}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p id={noteId} className={styles.note} aria-live="polite">
          {note}
        </p>
      </div>
    </div>
  );
}
