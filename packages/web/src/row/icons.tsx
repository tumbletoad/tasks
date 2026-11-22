// The row's icons (A5 3.20 "Row" and "Source kinds"): one set on a 24-unit grid with a 1.6 stroke,
// round caps and no fill except the filled star, inheriting the text colour. Every icon is
// decorative: the control or element that holds it has its name from the catalogue.
import type { ReactNode } from "react";
import { Icon } from "../app/Icons.tsx";

export const StarIcon = () => (
  <Icon>
    <path d="m12 3.6 2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8L8 13.6l-4.3-4 5.8-.7Z" />
  </Icon>
);

/** A pencil: words written and not sent yet. */
export const PencilIcon = () => (
  <Icon>
    <path d="M14.5 5.5 18.5 9.5M4.5 19.5l1-4.5L15.8 4.7a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5Z" />
  </Icon>
);

export const FolderIcon = () => (
  <Icon>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  </Icon>
);

/** A folder with an arrow: the place is on another machine. */
export const FolderElsewhereIcon = () => (
  <Icon>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    <path d="M10 13.5h5M13 11.5l2 2-2 2" />
  </Icon>
);

/** An arrow out of a box: shows the folder in the file manager. */
export const FolderOpenIcon = () => (
  <Icon>
    <path d="M13.5 4.5h6v6M19.5 4.5l-8 8" />
    <path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" />
  </Icon>
);

/** The waiting chip's person. */
export const PersonIcon = () => (
  <Icon>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);

/** A learning (A5 3.20 "Actions": learning, a bulb). */
export const BulbIcon = () => (
  <Icon>
    <path d="M9 17.5h6M10 20.5h4M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.5.4.8 1 .8 1.6v.5h5v-.5c0-.6.3-1.2.8-1.6A5.5 5.5 0 0 0 12 3.5Z" />
  </Icon>
);

/** A finished task's outcome (A5 3.20 "Actions": outcome, a check in a circle). */
export const OutcomeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="m8.5 12.2 2.4 2.3 4.6-4.8" />
  </Icon>
);

/** Collapse the expanded task (A5 3.20 "Actions": chevrons). */
export const ChevronUpIcon = () => (
  <Icon>
    <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />
  </Icon>
);

/** Run: an agent works on the task in the background. A play shape, open, never filled. */
export const RunIcon = () => (
  <Icon>
    <path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.9-6.2a.8.8 0 0 0 0-1.4L9.2 5.1a.8.8 0 0 0-1.2.7Z" />
  </Icon>
);

/** The late due's clock glyph: late and due-soon differ by text and by this shape (A5 3.19). */
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

const SOURCE_SHAPES: Readonly<Record<string, ReactNode>> = {
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  chat: (
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z" />
  ),
  ticket: (
    <>
      <path d="M3.5 8V6.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1V8a2.5 2.5 0 0 0 0 5v1.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V13a2.5 2.5 0 0 0 0-5Z" />
      <path d="M14 6v9" />
    </>
  ),
  pr: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M7 8v8M17 16v-6a3 3 0 0 0-3-3h-3M13 5l-2 2 2 2" />
    </>
  ),
  issue: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  doc: (
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M14 3.5V8h4M9 12.5h6M9 16h6" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  crash: <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12Z" />,
  book: (
    <>
      <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2Z" />
      <path d="M5 17.5a2 2 0 0 1 2-2h11" />
    </>
  ),
  session: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 10 3 2.5L7 15M12.5 15H17" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
};

/** The service's source kinds by the icon that shows them. */
const KIND_ALIASES: Readonly<Record<string, string>> = {
  email: "mail",
  slack: "chat",
  jira: "ticket",
  pull_request: "pr",
  document: "doc",
  event: "calendar",
};

export function SourceIcon({ kind }: { readonly kind: string }) {
  const shape = SOURCE_SHAPES[KIND_ALIASES[kind] ?? kind] ?? SOURCE_SHAPES["link"];
  return <Icon>{shape}</Icon>;
}
