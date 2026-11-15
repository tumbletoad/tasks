// A metadata source as a space source (A7 3.15.3, `sources` and `Source keys`): its kind from the
// URL, its key, and its title. Pure: a URL is parsed with the WHATWG parser, never fetched.
//
// Kind, in this order. It gives every URL the page gives a kind of its own the matching kind of the
// space (A7 3.15.3, Sources), and more:
// - a `mailto:` URL: `email`;
// - a `t3-thread:` URL, which names an agent thread: `session`;
// - a host ending in `atlassian.net` with a path that starts with `/wiki`: `doc`;
// - a path ending `/browse/<KEY>-<n>`: `ticket`, with `ref` `<KEY>-<n>` (the key upper-cased), when
//   `<KEY>-<n>` fits a ref's 300 characters;
// - any other URL of a host ending in `atlassian.net`: `ticket`, without a ref;
// - a code host's path `/<owner>/<repo>[/-]/pull|pulls|merge_requests/<n>`: `pr`, and with
//   `issues`: `issue`;
// - by the host's first label: `mail`, `outlook`, `webmail`: `email`; `chat`, `teams`: `chat`;
//   `calendar`: `calendar`; `docs`, `drive`, `sheets`, `slides`: `doc`;
// - anything else: `web`.
// A `file:` URL is a path on the machine that wrote it, no source: the mapping keeps its path
// (`fileLinkPath`).
//
// Key: a ticket's is `jira:<KEY>-<n>`. Every other URL's is `url:<normalised URL>` (A3 3.11.1):
// the WHATWG serialisation, which lower-cases the scheme and host, with `utm_*` query parameters
// removed and the fragment removed unless it holds a `/`. Such a fragment is an app's route, which
// names the item itself, as a webmail URL names its thread (`#inbox/<id>`): removing it would give
// every message of a mailbox one key, and one source row. A URL the parser refuses, or a key over
// 512 characters, gives no key.

export const SOURCE_KEY_MAX = 512;

/** The source kinds a mapping gives (A1 3.4's open set holds them). */
export type PlannedSourceKind =
  "email" | "chat" | "ticket" | "pr" | "issue" | "doc" | "calendar" | "session" | "web";

export interface UrlClass {
  readonly kind: PlannedSourceKind;
  /** Absent when the URL gives none: see `keyProblem`. */
  readonly key?: string;
  /** A ticket's key, such as `LUM-1000`. */
  readonly ref?: string;
  /** Why there is no key: the URL does not parse, or the key is over 512 characters. */
  readonly keyProblem?: "unparsed" | "too-long";
  /** A URL that parses with a scheme the page shows no link for (`mailto:`, `ftp:`). */
  readonly hidden?: true;
}

/** The schemes the page shows a link for. */
const SHOWN = new Set(["http:", "https:", "file:", "t3-thread:"]);

/**
 * The path a `file:` URL names, percent-decoded, when it names one on this machine's form of path:
 * no host, or `localhost`. Undefined for any other URL, and for one whose path does not decode.
 */
export function fileLinkPath(text: string): string | undefined {
  const url = URL.parse(text);
  if (url?.protocol !== "file:") return undefined;
  if (url.hostname !== "" && url.hostname !== "localhost") return undefined;
  try {
    const path = decodeURIComponent(url.pathname);
    // A Windows drive path is written `/C:/…`.
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

export const isFileLink = (text: string): boolean => URL.parse(text)?.protocol === "file:";

const TICKET = /\/browse\/([A-Za-z][A-Za-z0-9_]*-[0-9]+)\/?$/;
const DIGITS = /^[0-9]+$/;
const PR_SEGMENTS = new Set(["pull", "pulls", "merge_requests"]);

function codeKind(pathname: string): "pr" | "issue" | undefined {
  const segments = pathname.split("/").filter((s) => s !== "");
  // At least an owner and a repository before the kind.
  for (let i = 2; i < segments.length - 1; i += 1) {
    const s = segments[i] ?? "";
    if (!DIGITS.test(segments[i + 1] ?? "")) continue;
    if (PR_SEGMENTS.has(s)) return "pr";
    if (s === "issues") return "issue";
  }
  return undefined;
}

/** The kind a host's first label names. */
const HOST_KINDS: ReadonlyMap<string, PlannedSourceKind> = new Map([
  ["mail", "email"],
  ["outlook", "email"],
  ["webmail", "email"],
  ["chat", "chat"],
  ["teams", "chat"],
  ["calendar", "calendar"],
  ["docs", "doc"],
  ["drive", "doc"],
  ["sheets", "doc"],
  ["slides", "doc"],
]);

function hostKind(host: string): PlannedSourceKind {
  return HOST_KINDS.get(host.split(".")[0] ?? "") ?? "web";
}

/**
 * The query without its `utm_*` parameters, each other parameter kept as written. A name is read
 * percent-decoded (`%75tm_source` is `utm_source`); one that does not decode is kept.
 */
function withoutTracking(search: string): string {
  if (search.length <= 1) return search;
  const kept = search
    .slice(1)
    .split("&")
    .filter((part) => !trackingName(part.split("=", 1)[0] ?? ""));
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

function trackingName(name: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }
  return decoded.toLowerCase().startsWith("utm_");
}

/** The URL as a `url:` key normalises it (see the header). */
export function normaliseUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.search = withoutTracking(copy.search);
  if (!copy.hash.includes("/")) copy.hash = "";
  return copy.href;
}

/** A source's `ref` is one line of at most 300 characters in the space (A1 3.7). */
export const REF_MAX = 300;

export function classifyUrl(text: string): UrlClass {
  const url = URL.parse(text);
  if (url === null) return { kind: "web", keyProblem: "unparsed" };
  const hidden = SHOWN.has(url.protocol) ? {} : { hidden: true as const };
  const byUrl = (kind: PlannedSourceKind): UrlClass => ({
    ...keyed(kind, `url:${normaliseUrl(url)}`),
    ...hidden,
  });
  if (url.protocol === "mailto:") return byUrl("email");
  if (url.protocol === "t3-thread:") return byUrl("session");
  // The page's rule for its ticket and wiki host: a document under /wiki, else a ticket.
  const atlassian = url.hostname.endsWith("atlassian.net");
  if (atlassian && url.pathname.startsWith("/wiki")) return byUrl("doc");
  const ticket = TICKET.exec(url.pathname);
  // A key longer than a ref can hold is no ticket's: the URL is classified as any other.
  if (ticket !== null && (ticket[1] ?? "").length <= REF_MAX) {
    const ref = (ticket[1] ?? "").toUpperCase();
    return { ...keyed("ticket", `jira:${ref}`), ref, ...hidden };
  }
  if (atlassian) return byUrl("ticket");
  return byUrl(codeKind(url.pathname) ?? hostKind(url.hostname));
}

function keyed(kind: PlannedSourceKind, key: string): UrlClass {
  return Array.from(key).length <= SOURCE_KEY_MAX
    ? { kind, key }
    : { kind, keyProblem: "too-long" };
}

/**
 * Labels that only name a kind of source ("Email", "Chat"), compared without case and without
 * a trailing dot or colon. An empty label is generic too.
 */
const GENERIC_LABELS = new Set([
  "",
  "email",
  "e-mail",
  "mail",
  "message",
  "thread",
  "chat",
  "ticket",
  "jira",
  "issue",
  "pr",
  "pull request",
  "merge request",
  "doc",
  "docs",
  "document",
  "drive",
  "file",
  "calendar",
  "event",
  "meeting",
  "link",
  "url",
  "web",
  "website",
  "page",
]);

export function isGenericLabel(label: string): boolean {
  // A loop, not `/[.:]+$/`, which retries from every position of a long run of dots.
  const text = label.trim();
  let end = text.length;
  while (end > 0 && (text.charAt(end - 1) === "." || text.charAt(end - 1) === ":")) end -= 1;
  return GENERIC_LABELS.has(text.slice(0, end).trimEnd().toLowerCase());
}

/** The short form of a URL that stands as a generic source's title: at most 80 characters. */
export const SHORT_URL_MAX = 80;

export function shortUrl(text: string): string {
  const url = URL.parse(text);
  let short = text;
  if (url !== null && url.host !== "") {
    const route = url.hash.includes("/") ? url.hash : "";
    const path =
      url.pathname === "/" && route === ""
        ? ""
        : route === ""
          ? url.pathname.replace(/\/$/, "")
          : url.pathname;
    short = `${url.host.replace(/^www\./, "")}${path}${route}`;
  }
  const chars = Array.from(short);
  return chars.length <= SHORT_URL_MAX ? short : `${chars.slice(0, SHORT_URL_MAX - 1).join("")}…`;
}
