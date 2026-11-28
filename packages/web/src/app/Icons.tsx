// The shell's icons (A5 3.20): one set on a 24-unit grid with a 1.6 stroke, round caps and no
// fill, inheriting the text colour. Drawn for this page from plain shapes. Every icon is
// decorative: the control that holds it has its name from the message catalogue.
import type { ReactNode } from "react";
import type { View } from "./views.ts";

export function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const VIEW_SHAPES: Readonly<Record<View, ReactNode>> = {
  // Sun: a disc and eight short rays.
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  // Tray: an open box with a dip in its rim.
  inbox: (
    <>
      <path d="M4 13 6.5 5.5h11L20 13" />
      <path d="M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5h-4.5l-1 2h-5l-1-2Z" />
    </>
  ),
  // List: three lines with their points.
  open: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </>
  ),
  // Hourglass.
  waiting: (
    <>
      <path d="M6 3h12M6 21h12" />
      <path d="M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9" />
    </>
  ),
  // Eye.
  review: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  // Layers: three stacked sheets.
  backlog: (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16 12 20.5l8.5-4.5" />
    </>
  ),
  // Check in a circle.
  completed: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  // Terminal: a prompt and a cursor line.
  agents: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 10 3 2.5L7 15M12.5 15H17" />
    </>
  ),
  // A pulse: what happened, as it happened.
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  // Bin: a lid with its handle and a tapered can.
  trash: (
    <>
      <path d="M4 6.5h16M9.5 6.5V4.5h5v2" />
      <path d="m6 6.5 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 10.5v6M14 10.5v6" />
    </>
  ),
};

export const ViewIcon = ({ view }: { readonly view: View }) => <Icon>{VIEW_SHAPES[view]}</Icon>;

/** Sliders: Settings. */
export const SettingsIcon = () => (
  <Icon>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon>
    <path d="m7 10 5 5 5-5" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

/** A lens: search. */
export const SearchIcon = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="5.5" />
    <path d="m15 15 4.5 4.5" />
  </Icon>
);

/** A small cross: take a shortcut back into the text. */
export const CrossIcon = () => (
  <Icon>
    <path d="m8 8 8 8M16 8l-8 8" />
  </Icon>
);

export const UpIcon = () => (
  <Icon>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const DownIcon = () => (
  <Icon>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);

/** Three dots: more actions. */
export const MoreIcon = () => (
  <Icon>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />
  </Icon>
);
