// The tab's route: the space lives in the URL, so each tab keeps its own space, and a
// reload, Back and Forward or a link from `ttasks open` land on it. The router (app/router.tsx)
// owns the routes; this module reads what arrives from outside, by its shape only: the path a
// link names and the sign-in fragment. Both come from whoever wrote the link.
//
//   /                              the machine's default space, resolved by the page
//   /?task=<ref>                   a task in the default space (`ttasks open <task>` without a space)
//   /s/<space ID>/<view…>          a view of the space, at most five plain segments
//   /s/<space ID>/search?q=<words> a search of the space
//   /s/<space ID>/task/<ref>       a task of the space, expanded
//
// The skeleton's task links (`/s/<space>/t/<ref>`) still land on the task.

export const SPACE_ID = /^sp_[0-9a-z]{26}$/;
/** A plain path segment: a view, an ID or a task reference. */
export const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The route of a space the page does not have, for whatever stood in the place of a space that is
 * no space ID: an older command line put a space's name there, which may hold any character. The
 * page says so there and chooses no space, since landing on the default would put the person's
 * next edit in another list.
 */
export const NO_SUCH_SPACE = "/s/unknown";
/** A sign-in code: 32 random bytes as base64url. */
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
  if (s !== "s" || space === undefined || space === "") return undefined;
  if (!SPACE_ID.test(space)) return NO_SUCH_SPACE;
  if (rest.length > 5 || !rest.every((segment) => SEGMENT.test(segment))) return undefined;
  if (rest.length === 2 && rest[0] === "t") return `/s/${space}/task/${rest[1] ?? ""}`;
  return `/s/${[space, ...rest].join("/")}`;
}

/** What the feed client needs of the route: the tab's space (and a task, for the skeleton). */
export interface PageRoute {
  readonly space?: string;
  readonly task?: string;
}

/** The most a search holds: what the top field takes. */
const QUERY_MAX = 500;

/**
 * The search of the search route's address (`?q=`): its words and filters, so a reload, a copied
 * link and a bookmark open that search.
 */
export function searchQueryOf(location: { readonly search: unknown }): string {
  const q = (location.search as { q?: unknown } | null | undefined)?.q;
  return typeof q === "string" && q.length <= QUERY_MAX ? q : "";
}

export interface Fragment {
  /** A one-time sign-in code, when the fragment held one of the right shape. */
  readonly code?: string;
  /** Where `ttasks open` asked the tab to go: a page path. */
  readonly to?: string;
}

/** `#k=<code>&to=<path>`, checked. Anything else in it is ignored. */
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
