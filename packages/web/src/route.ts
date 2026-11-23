// The tab's route (A5 3.3): the space lives in the URL, so each tab keeps its own space, and a
// reload, Back and Forward or a link from `ttasks open` land on it. The router (app/router.tsx)
// owns the routes; this module reads what arrives from outside, by its shape only: the path a
// link names and the sign-in fragment. Both come from whoever wrote the link.
//
//   /                              the machine's default space (A2 3.1), resolved by the page
//   /?task=<ref>                   a task in the default space (`ttasks open <task>` without a space)
//   /s/<space>/<view…>             a view of the space, at most four plain segments
//   /s/<space>/task/<ref>          a task of the space, expanded
//
// <space> is the space's ID, which means the copy the service picks (the one that takes changes),
// or a copy's own address, `<space ID>-copy-<digest>`, which means that copy and no other: a
// restored copy opened to look inside it.
//
// The skeleton's task links (`/s/<space>/t/<ref>`) still land on the task.

export const SPACE_ID = /^sp_[0-9a-z]{26}$/;
/** A space's ID, or one copy's address: its ID, `-copy-` and a digest of its folder. */
export const SPACE_ADDRESS = /^sp_[0-9a-z]{26}(?:-copy-[0-9a-f]{12})?$/;

/** The space ID an address names a copy of. */
export const spaceIdOf = (address: string): string => address.slice(0, 29);
/** A plain path segment: a view, an ID or a task reference. */
export const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
/** A sign-in code: 32 random bytes as base64url (A2 3.8.4). */
const CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A path of the page (one the service answers with the shell), normalised, or undefined for any
 * other path. Never another origin: only a path that starts with one `/` is read.
 */
export function pagePath(path: string): string | undefined {
  if (path === "/" || path === "/index.html") return "/";
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  const parts = path.replace(/\/$/, "").split("/").slice(1);
  if (parts[0] === "task" && parts.length === 2 && SEGMENT.test(parts[1] ?? "")) {
    return `/?task=${parts[1] ?? ""}`;
  }
  const [s, space, ...rest] = parts;
  if (s !== "s" || space === undefined || !SPACE_ADDRESS.test(space)) return undefined;
  if (rest.length > 4 || !rest.every((segment) => SEGMENT.test(segment))) return undefined;
  if (rest.length === 2 && rest[0] === "t") return `/s/${space}/task/${rest[1] ?? ""}`;
  return `/s/${[space, ...rest].join("/")}`;
}

/** What the feed client needs of the route: the tab's space (and a task, for the skeleton). */
export interface PageRoute {
  readonly space?: string;
  readonly task?: string;
}

export interface Fragment {
  /** A one-time sign-in code, when the fragment held one of the right shape. */
  readonly code?: string;
  /** Where `ttasks open` asked the tab to go: a page path. */
  readonly to?: string;
}

/** `#k=<code>&to=<path>` (A2 3.8.4 step 3), checked. Anything else in it is ignored. */
export function readFragment(hash: string): Fragment {
  if (!hash.startsWith("#") || hash.length > 512) return {};
  const params = new URLSearchParams(hash.slice(1));
  const code = params.get("k");
  const to = params.get("to");
  const path = to === null ? undefined : pagePath(to);
  return {
    ...(code !== null && CODE.test(code) ? { code } : {}),
    ...(path === undefined ? {} : { to: path }),
  };
}
