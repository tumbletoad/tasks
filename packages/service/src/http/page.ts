// What the listener serves to a browser: the app shell, its hashed files, and nothing else.
//
// The UI itself is M2.13's. Until it exists the service serves a minimal shell of its own that
// proves the parts this step owns: the style nonce (its one `<style>` carries the nonce from the
// meta tag), the token hand-over (fragment code, redeem, `localStorage`, the fragment removed),
// and the change feed (a WebSocket ticket, `subscribe`, the snapshot and the batches). It writes
// text with `textContent` only, so it runs under Trusted Types.
//
// The built UI arrives as a folder (`loadUiFolder`): its `index.html` carries the placeholder
// `__TASKS_NONCE__` wherever the per-response nonce goes, and its files sit under `assets/` with
// hashed names. Every script and stylesheet the shell loads carries an integrity hash (A2 3.8.3).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { APP_NAME, CLI_NAME, httpHeader, PRODUCT_ID } from "@tasks/brand";
import { metaContent, startTags } from "./tags.ts";

/** Where a built `index.html` takes the per-response style nonce. */
export const NONCE_PLACEHOLDER = "__TASKS_NONCE__";

/** One file the listener serves at a path of its own. */
export interface UiFile {
  readonly body: Buffer;
  readonly type: string;
}

/** The shell and its files, read once at start. */
export interface UiBundle {
  /** `index.html` with NONCE_PLACEHOLDER where the nonce goes. */
  readonly index: string;
  /** Files by path: `/assets/<name>` (immutable) and root files such as `/manifest.webmanifest`. */
  readonly files: ReadonlyMap<string, UiFile>;
}

/** The media types the listener serves. A file of another type is not served. */
export const UI_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** The localStorage key of the token (A2 3.8.4). */
export const TOKEN_KEY = `${PRODUCT_ID}.token`;

/** `sha384-<base64>`, the integrity value of a file. */
export function integrity(body: Buffer | string): string {
  return `sha384-${createHash("sha384").update(body).digest("base64")}`;
}

// The shell's script. Plain JavaScript for the browser: it reads the fragment, removes it before
// any request, redeems a code, keeps the token, opens the feed and shows what arrives. Values read
// back from localStorage are untrusted (A5 3.24): a token is used only when it has the token shape.
const BOOT = `"use strict";
const TOKEN_KEY = ${JSON.stringify(TOKEN_KEY)};
const TOKEN = /^tasks_u_[A-Za-z0-9_-]{43}$/;
const SPACE = /^\\/s\\/(sp_[0-9a-z]{26})(?:\\/|$)/;
const status = document.getElementById("status");
const detail = document.getElementById("detail");
const say = (line, more) => { status.textContent = line; detail.textContent = more || ""; };
const build = document.querySelector('meta[name="tasks-build"]')?.getAttribute("content") || "";
const fragment = new URLSearchParams(location.hash.slice(1));
const code = fragment.get("k");
const to = fragment.get("to") || "";
if (location.hash !== "") history.replaceState(null, "", location.pathname + location.search);
const read = () => { try { const t = localStorage.getItem(TOKEN_KEY); return typeof t === "string" && TOKEN.test(t) ? t : null; } catch { return null; } };
const keep = (t) => { try { if (t === null) localStorage.removeItem(TOKEN_KEY); else localStorage.setItem(TOKEN_KEY, t); } catch {} };
const post = (path, body, token) => fetch(path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json", ${JSON.stringify(httpHeader("build"))}: build }, token ? { Authorization: "Bearer " + token } : {}),
  body: JSON.stringify(body),
  credentials: "omit",
  cache: "no-store",
  referrerPolicy: "no-referrer",
});
const signedOut = () => { keep(null); document.documentElement.dataset.state = "signed-out"; say("Run ${CLI_NAME} open to sign in this browser."); };
async function start() {
  let token = read();
  if (code) {
    const reply = await post("/api/v1/auth/redeem", { code });
    if (reply.ok) { const body = await reply.json(); if (typeof body.token === "string" && TOKEN.test(body.token)) { token = body.token; keep(token); } }
  }
  if (!token) { signedOut(); return; }
  const ticketReply = await post("/api/v1/ws-ticket", {}, token);
  if (ticketReply.status === 401) { signedOut(); return; }
  if (ticketReply.status === 409) { say("${APP_NAME} was updated. Reload this page."); return; }
  if (!ticketReply.ok) { say("${APP_NAME}'s service did not answer."); return; }
  const { ticket } = await ticketReply.json();
  const space = SPACE.exec(to)?.[1];
  const ws = new WebSocket("ws://" + location.host + "/api/v1/ws?ticket=" + encodeURIComponent(ticket));
  let open = 0;
  let cursor = null;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      document.documentElement.dataset.build = String(message.build);
      ws.send(JSON.stringify(space ? { type: "subscribe", space } : { type: "subscribe" }));
    } else if (message.type === "snapshot") {
      open = message.tasks.length;
      cursor = message.cursor;
      document.documentElement.dataset.state = "live";
      say(message.space.name + ": " + open + " open", "As of " + cursor.seq);
    } else if (message.type === "batch") {
      if (cursor === null || message.from !== cursor.seq) { ws.send(JSON.stringify({ type: "subscribe", space: message.space_id })); return; }
      cursor = { epoch: message.epoch, incarnation: message.incarnation, seq: message.through };
      document.documentElement.dataset.seq = String(cursor.seq);
      detail.textContent = "As of " + cursor.seq;
    } else if (message.type === "error") {
      say("${APP_NAME} cannot show this space: " + String(message.code) + ".");
    }
  };
  ws.onclose = (event) => { if (event.code === 4401) signedOut(); else if (document.documentElement.dataset.state !== "signed-out") say("${APP_NAME}'s service is not running."); };
}
start().catch(() => say("${APP_NAME}'s service did not answer."));
`;

const STYLE =
  "body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#16161a;color:#e6e4df}" +
  "main{max-width:40rem;margin:20vh auto;padding:0 1.5rem}" +
  "h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}#detail{color:#9a978f}";

/** The minimal shell this step serves until M2.13's UI replaces it. */
export function builtinUi(build: { version: string; build: string }): UiBundle {
  const boot = Buffer.from(BOOT, "utf8");
  const bootPath = `/assets/boot-${createHash("sha256").update(boot).digest("hex").slice(0, 12)}.js`;
  const index = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="csp-nonce" content="${NONCE_PLACEHOLDER}">`,
    `<meta name="tasks-build" content="${escapeAttr(build.build)}">`,
    `<title>${APP_NAME}</title>`,
    `<style nonce="${NONCE_PLACEHOLDER}">${STYLE}</style>`,
    `<script src="${bootPath}" integrity="${integrity(boot)}" defer></script>`,
    "</head>",
    "<body>",
    `<main><h1>${APP_NAME}</h1><p id="status">Starting.</p><p id="detail"></p></main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return {
    index,
    files: new Map([[bootPath, { body: boot, type: UI_TYPES[".js"] ?? "text/javascript" }]]),
  };
}

function escapeAttr(text: string): string {
  return text.replace(/[&"<>]/g, (ch) => `&#${String(ch.codePointAt(0))};`);
}

export class UiFolderInvalid extends Error {}

/** Where a built `index.html` takes the build of the service that serves it (`Tasks-Build`). */
export const BUILD_PLACEHOLDER = "__TASKS_BUILD__";

/**
 * What is wrong with a built `index.html` against its files (A2 3.8.3 "Asset integrity", A5
 * 3.26): every script is a file of the bundle with the integrity hash of its bytes, and so is every
 * stylesheet and module preload; no inline script, and no inline style without the nonce; the
 * nonce's meta tag, as a browser reads it. One line per problem; none means the page loads nothing
 * the CSP and SRI do not cover. The tags are read by tags.ts, as doctor's self-test reads them.
 */
export function indexProblems(index: string, files: ReadonlyMap<string, UiFile>): string[] {
  const problems: string[] = [];
  const hashed = (what: string, url: string | undefined, sri: string | undefined) => {
    const file = url === undefined ? undefined : files.get(url);
    if (file === undefined) problems.push(`${what} is not a file of the bundle`);
    else if (sri !== integrity(file.body))
      problems.push(`${what} ${url ?? ""} has no valid integrity`);
  };
  const tags = startTags(index);
  for (const { name, attributes: attrs } of tags) {
    if (name === "script") {
      if (!attrs.has("src")) problems.push("an inline script");
      else hashed("a script", attrs.get("src"), attrs.get("integrity"));
    } else if (name === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet") || rel.includes("modulepreload") || rel.includes("preload")) {
        hashed(`a ${rel.join(" ")} link`, attrs.get("href"), attrs.get("integrity"));
      }
    } else if (name === "style" && attrs.get("nonce") !== NONCE_PLACEHOLDER) {
      problems.push("a style without nonce");
    }
  }
  if (metaContent(index, "csp-nonce") !== NONCE_PLACEHOLDER) {
    problems.push("no csp-nonce meta tag");
  }
  return problems;
}

/**
 * Reads a built UI folder once (M2.13): `index.html` with the nonce placeholder, the files under
 * `assets/`, and the plain files at the root. Only regular files of a known type are served. A
 * folder whose `index.html` would load anything without an integrity hash is refused, and its
 * build placeholder becomes this service's build, which the page sends back as `Tasks-Build`.
 */
export function loadUiFolder(dir: string, build?: { readonly build: string }): UiBundle {
  const root = realpathSync.native(dir);
  const read = readFileSync(join(root, "index.html"), "utf8");
  if (!read.includes(NONCE_PLACEHOLDER)) throw new UiFolderInvalid("index.html has no nonce");
  const index =
    build === undefined ? read : read.replaceAll(BUILD_PLACEHOLDER, escapeAttr(build.build));
  const files = new Map<string, UiFile>();
  const add = (folder: string, prefix: string) => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === "index.html") continue;
      const path = join(folder, name);
      const type = UI_TYPES[extname(name).toLowerCase()];
      if (type !== undefined && statSync(path).isFile()) {
        files.set(`${prefix}${name}`, { body: readFileSync(path), type });
      }
    }
  };
  add(root, "/");
  add(join(root, "assets"), "/assets/");
  const problems = indexProblems(index, files);
  if (problems.length > 0) throw new UiFolderInvalid(`index.html: ${problems.join("; ")}`);
  return { index, files };
}
