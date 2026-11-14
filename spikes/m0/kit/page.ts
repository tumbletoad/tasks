// The stand-in service's browser page for rows U01-U04 and U06: fragment-code bootstrap, token in
// localStorage, reload with the stored token, WebSocket echo, strict CSP with a style nonce,
// clipboard on a click, the page's keyboard shortcuts, an https: link and Reveal buttons. Reveal
// is an authenticated service action that names a folder by index, never by path. The page posts
// its check results to /api/v1/spike/report, so the lab reads them from the service's events
// instead of screenshots.

export function indexHtml(styleNonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csp-nonce" content="${styleNonce}">
<title>Tasks M0 spike page</title>
<style nonce="${styleNonce}">
body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; max-width: 720px; }
li { margin: 4px 0; }
.ok { color: #1a7f37; }
.fail { color: #cf222e; }
</style>
<script src="/app.js" defer></script>
</head>
<body>
<h1>Tasks M0 spike page</h1>
<p>Stand-in service for the lab. Fixture space Mira. Press <kbd>/</kbd>, <kbd>Ctrl+K</kbd>,
<kbd>Ctrl+Enter</kbd> or <kbd>Ctrl+Shift+Enter</kbd> to check the shortcuts.</p>
<p><button id="copy" type="button">Copy fixture text</button>
<a href="https://example.org/" target="_blank" rel="noopener noreferrer">Open an https: link</a></p>
<p id="reveal">Reveal in the file manager: </p>
<p id="probe">Style probe</p>
<ul id="out"></ul>
</body>
</html>
`;
}

export const APP_JS = `"use strict";
const out = document.getElementById("out");
const results = {};
function record(name, value) {
  results[name] = value;
  const li = document.createElement("li");
  li.textContent = name + ": " + value;
  li.className = value.startsWith("ok") ? "ok" : value.startsWith("fail") ? "fail" : "";
  out.append(li);
}
function api(path, options = {}) {
  const headers = { "content-type": "application/json" };
  const token = localStorage.getItem("tasks.token");
  if (token) headers.authorization = "Bearer " + token;
  return fetch(path, { ...options, headers });
}
async function report() {
  try { await api("/api/v1/spike/report", { method: "POST", body: JSON.stringify({ checks: results }) }); } catch {}
}
async function websocket() {
  const res = await api("/api/v1/ws-ticket", { method: "POST", body: "{}" });
  if (!res.ok) { record("websocket", "fail ticket " + res.status); return; }
  const { ticket } = await res.json();
  await new Promise((resolve) => {
    const ws = new WebSocket("ws://" + location.host + "/api/v1/ws?ticket=" + encodeURIComponent(ticket));
    const timer = setTimeout(() => { record("websocket", "fail timeout"); resolve(); }, 5000);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "hello") ws.send(JSON.stringify({ type: "echo", text: "Mira echo" }));
      if (msg.type === "echo") {
        record("websocket", msg.text === "Mira echo" ? "ok" : "fail wrong echo");
        clearTimeout(timer); ws.close(); resolve();
      }
    };
    ws.onerror = () => { record("websocket", "fail error"); clearTimeout(timer); resolve(); };
  });
}
async function main() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get("k");
  if (code) {
    history.replaceState(null, "", location.pathname + location.search);
    const res = await fetch("/api/v1/auth/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (res.ok) { localStorage.setItem("tasks.token", (await res.json()).token); record("redeem", "ok"); }
    else record("redeem", "fail " + res.status);
  } else {
    record("redeem", localStorage.getItem("tasks.token") ? "skipped, stored token" : "fail no code and no token");
  }
  record("fragment removed", location.hash === "" ? "ok" : "fail");
  const session = await api("/api/v1/session");
  record("session", session.ok ? "ok" : "fail " + session.status);
  const probe = document.getElementById("probe");
  const nonce = document.querySelector('meta[name="csp-nonce"]').content;
  const good = document.createElement("style");
  good.nonce = nonce;
  good.textContent = "#probe { outline: 3px solid rgb(0, 128, 0); }";
  document.head.append(good);
  record("style with nonce", getComputedStyle(probe).outlineColor === "rgb(0, 128, 0)" ? "ok" : "fail");
  const bad = document.createElement("style");
  bad.textContent = "#probe { text-decoration-line: line-through; }";
  document.head.append(bad);
  record("style without nonce blocked", getComputedStyle(probe).textDecorationLine === "line-through" ? "fail" : "ok");
  if (session.ok) await websocket();
  if (session.ok) await revealButtons();
  await report();
}
async function revealButtons() {
  const res = await api("/api/v1/spike/reveal-targets");
  if (!res.ok) { record("reveal targets", "fail " + res.status); return; }
  const { targets } = await res.json();
  const holder = document.getElementById("reveal");
  for (const target of targets) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = target.label;
    button.addEventListener("click", async () => {
      const opened = await api("/api/v1/spike/reveal", { method: "POST", body: JSON.stringify({ index: target.index }) });
      record("reveal " + target.label, opened.ok ? "ok opener started" : "fail " + opened.status);
      await report();
    });
    holder.append(button, " ");
  }
}
document.getElementById("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText("Mira fixture M-14"); record("clipboard", "ok"); }
  catch (error) { record("clipboard", "fail " + error.name); }
  await report();
});
const shortcuts = new Set(["/", "Ctrl+K", "Ctrl+Enter", "Ctrl+Shift+Enter"]);
window.addEventListener("keydown", (event) => {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const combo = (event.ctrlKey ? "Ctrl+" : "") + (event.shiftKey && key !== "/" ? "Shift+" : "") + key;
  if (!shortcuts.has(combo)) return;
  event.preventDefault();
  record("key " + combo, "ok reached the page");
  void report();
});
main().catch((error) => { record("bootstrap", "fail " + error.name); void report(); });
`;
