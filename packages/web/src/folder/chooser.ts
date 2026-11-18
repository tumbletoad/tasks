// The folder chooser's choices, from what the service listed for the text in the field. Plain code
// without React, so every case is a unit test. A choice sets the field's text: a folder's ends in
// its separator, so the next listing is that folder's.
import type { FolderListing, FolderProject } from "../api.ts";

export interface Choice {
  readonly key: string;
  readonly kind: "home" | "place" | "root" | "folder" | "make";
  /** What the choice shows: a name, a folder or a drive. */
  readonly label: string;
  /** The field's text once it is chosen; for `make`, the folder to make. */
  readonly value: string;
  readonly link?: true;
  readonly project?: FolderProject | string;
}

/** The choices for a listing; `make` offers to make the folder whose name was typed. */
export function choicesOf(listing: FolderListing | undefined, make: boolean): Choice[] {
  if (listing === undefined || listing.kind === "problem") return [];
  const { sep } = listing;
  if (listing.kind === "start") {
    return [
      ...listing.places.map((place): Choice =>
        place.folder === "~"
          ? { key: "home", kind: "home", label: "~", value: `~${sep}` }
          : {
              key: `place:${place.folder}`,
              kind: "place",
              label: place.folder,
              value: `${place.folder}${sep}`,
              ...(place.project === undefined ? {} : { project: place.project }),
            },
      ),
      ...listing.roots.map((root): Choice => ({
        key: `root:${root}`,
        kind: "root",
        label: root,
        value: root,
      })),
    ];
  }
  const choices: Choice[] = listing.folders.map((folder) => ({
    key: `folder:${folder.name}`,
    kind: "folder",
    label: folder.name,
    value: `${listing.at}${folder.name}${sep}`,
    ...(folder.link === undefined ? {} : { link: true }),
    ...(folder.project === undefined ? {} : { project: folder.project }),
  }));
  const typed = listing.prefix.trim();
  if (make && typed !== "" && typed === listing.prefix && listing.exact === undefined) {
    choices.push({
      key: "make",
      kind: "make",
      label: typed,
      value: `${listing.at}${typed}`,
    });
  }
  return choices;
}

/**
 * The folder a field's text names, as typed: the service drops a trailing separator by the rules
 * of its own system, where a `\` can be part of a Linux folder's name. A drive letter alone is its
 * root, as the chooser lists it. Undefined for an empty text.
 */
export function chosenFolder(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^[A-Za-z]:$/u.test(trimmed)) return `${trimmed}\\`;
  return trimmed === "" ? undefined : trimmed;
}
