// The session checks of rows U01-U04 and U06, ported from the kit's plain page (kit/page.ts):
// fragment-code bootstrap, token in localStorage, session after reload, style with and without
// the nonce, WebSocket echo, Trusted Types, no service worker, clipboard on a click, the four
// shortcuts, reveal buttons. Plus a CSP violation counter for the whole page. Results go through
// report.ts to the stand-in service.
import { api, metric, record, report, token } from "./report.ts";

/**
 * Violations the page causes on purpose, by directive, at most this many: the style probe
 * (style-src-elem, or style-src in browsers without the -elem split), the Trusted Types probe and
 * the untrusted service-worker URL (require-trusted-types-for), and the worker probe (worker-src).
 */
const PROBED = new Map([
  ["style-src-elem", 1],
  ["style-src", 1],
  ["require-trusted-types-for", 2],
  ["worker-src", 1],
]);
const violations = new Map<string, number>();

/** Installs the CSP listener. Call before anything else runs, so no violation is missed. */
export function watchCsp(): void {
  document.addEventListener("securitypolicyviolation", (event) => {
    const directive = event.effectiveDirective || event.violatedDirective;
    violations.set(directive, (violations.get(directive) ?? 0) + 1);
    const unexpected = [...violations].reduce(
      (sum, [d, n]) => sum + Math.max(0, n - (PROBED.get(d) ?? 0)),
      0,
    );
    metric(
      "csp_violations_total",
      [...violations.values()].reduce((a, b) => a + b, 0),
    );
    metric("csp_violations_unexpected", unexpected);
    record(
      "csp violations",
      [...violations]
        .map(([d, n]) => `${d} ${String(n)}`)
        .join(", ")
        .slice(0, 80),
    );
  });
}

export function browserLabel(): string {
  const ua = navigator.userAgent;
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return `Firefox ${firefox[1] ?? ""}`;
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return `Edge ${edge[1] ?? ""}`;
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return `Chrome ${chrome[1] ?? ""}`;
  return "other";
}

/** Chromium reduces the user agent to "157.0.0.0": the full version comes from client hints. */
async function fullBrowserLabel(): Promise<string> {
  const data = (
    navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues(hints: string[]): Promise<{
          fullVersionList?: { brand: string; version: string }[];
        }>;
      };
    }
  ).userAgentData;
  if (data === undefined) return browserLabel();
  try {
    const { fullVersionList = [] } = await data.getHighEntropyValues(["fullVersionList"]);
    const brand =
      fullVersionList.find((b) => b.brand === "Microsoft Edge") ??
      fullVersionList.find((b) => b.brand === "Google Chrome") ??
      fullVersionList.find((b) => b.brand === "Chromium");
    return brand === undefined ? browserLabel() : `${brand.brand} ${brand.version}`;
  } catch {
    return browserLabel();
  }
}

function platformLabel(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Mac OS")) return "macOS";
  return "other";
}

async function redeem(): Promise<void> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get("k");
  if (code !== null) {
    // A2 3.8.4 step 4: remove the fragment first, then spend the code.
    history.replaceState(null, "", location.pathname + location.search);
    const res = await fetch("/api/v1/auth/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token: string };
      try {
        localStorage.setItem("tasks.token", body.token);
        record("redeem", "ok");
      } catch (error) {
        record("redeem", `fail localStorage ${(error as Error).name}`);
      }
    } else record("redeem", `fail ${String(res.status)}`);
  } else {
    record("redeem", token() === null ? "fail no code and no token" : "skipped, stored token");
  }
  record("fragment removed", location.hash === "" ? "ok" : "fail");
}

function styleNonce(): void {
  const probe = document.getElementById("style-probe");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]');
  if (probe === null || meta === null) {
    record("style with nonce", "fail no probe");
    return;
  }
  const good = document.createElement("style");
  good.nonce = meta.content;
  good.textContent = "#style-probe { outline: 3px solid rgb(0, 128, 0); }";
  document.head.append(good);
  record(
    "style with nonce",
    getComputedStyle(probe).outlineColor === "rgb(0, 128, 0)" ? "ok" : "fail",
  );
  const bad = document.createElement("style");
  bad.textContent = "#style-probe { text-decoration-line: line-through; }";
  document.head.append(bad);
  record(
    "style without nonce blocked",
    getComputedStyle(probe).textDecorationLine === "line-through" ? "fail" : "ok",
  );
  // The served document carries the nonce only in its meta tag and header, never twice.
  record(
    "nonce meta filled",
    meta.content.length >= 16 && !meta.content.includes("TTASKS") ? "ok" : "fail",
  );
}

/**
 * A5 section 5 item 1: React Aria's press style element reads the nonce from the csp-nonce meta
 * tag and applies under the policy. usePress inserts it once, after the first pressable mounts.
 */
function reactAriaNonce(): void {
  const style = document.getElementById("react-aria-pressable-style");
  const pressable = document.querySelector("[data-react-aria-pressable]");
  if (!(style instanceof HTMLStyleElement) || pressable === null) {
    record("react aria style", "fail not inserted");
    return;
  }
  record("react aria style nonce", style.nonce !== "" ? "ok" : "fail no nonce");
  record(
    "react aria style applied",
    // Chromium serialises "pan-x pan-y pinch-zoom" as its equivalent "manipulation".
    ["pan-x pan-y pinch-zoom", "manipulation"].includes(getComputedStyle(pressable).touchAction)
      ? "ok"
      : `fail ${getComputedStyle(pressable).touchAction}`,
  );
}

function trustedTypes(): void {
  // Chromium enforces require-trusted-types-for 'script' (A5 3.26). Firefox may not yet.
  const div = document.createElement("div");
  try {
    div.innerHTML = "<b>Mira</b>";
    record("trusted types", "not enforced");
  } catch {
    record("trusted types", "enforced");
  }
}

async function websocket(): Promise<void> {
  const res = await api("/api/v1/ws-ticket", { method: "POST", body: "{}" });
  if (!res.ok) {
    record("websocket", `fail ticket ${String(res.status)}`);
    return;
  }
  const { ticket } = (await res.json()) as { ticket: string };
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(
      `ws://${location.host}/api/v1/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const timer = setTimeout(() => {
      record("websocket", "fail timeout");
      resolve();
    }, 5000);
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; text?: string };
      if (msg.type === "hello") ws.send(JSON.stringify({ type: "echo", text: "Mira echo" }));
      if (msg.type === "echo") {
        record("websocket", msg.text === "Mira echo" ? "ok" : "fail wrong echo");
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      record("websocket", "fail error");
      clearTimeout(timer);
      resolve();
    };
  });
}

async function serviceWorker(): Promise<void> {
  // A5 U27 and A2 3.8.3: no service worker, and worker-src 'none' refuses one.
  if (!("serviceWorker" in navigator)) {
    record("service worker", "api absent");
    return;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  record(
    "service workers registered",
    registrations.length === 0 ? "ok none" : `fail ${String(registrations.length)}`,
  );
  record("page controlled", navigator.serviceWorker.controller === null ? "ok no" : "fail yes");
  // The file does not exist (404), so even a browser that ignored the CSP registers nothing.
  // A plain string: Chromium's Trusted Types refuse it first (TypeError), Firefox's worker-src.
  try {
    await navigator.serviceWorker.register("/sw-probe.js", { scope: "/" });
    record("service worker register", "fail accepted");
  } catch (error) {
    record("service worker register", `ok refused ${(error as Error).name}`);
  }
  // A trusted URL gets past Trusted Types, so only worker-src 'none' can refuse it.
  const tt = (window as unknown as { trustedTypes?: TrustedFactory }).trustedTypes;
  if (tt === undefined) return;
  try {
    const policy = tt.createPolicy("ttasks-sw-probe", { createScriptURL: (url: string) => url });
    await navigator.serviceWorker.register(policy.createScriptURL("/sw-probe.js") as string, {
      scope: "/",
    });
    record("service worker trusted url", "fail accepted");
  } catch (error) {
    record("service worker trusted url", `ok refused ${(error as Error).name}`);
  }
}

interface TrustedFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL: (url: string) => string },
  ): { createScriptURL(url: string): unknown };
}

export async function revealTargets(): Promise<{ index: number; label: string }[]> {
  const res = await api("/api/v1/spike/reveal-targets");
  if (!res.ok) {
    record("reveal targets", `fail ${String(res.status)}`);
    return [];
  }
  return ((await res.json()) as { targets: { index: number; label: string }[] }).targets;
}

export async function reveal(index: number, label: string): Promise<void> {
  const opened = await api("/api/v1/spike/reveal", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
  record(`reveal ${label}`, opened.ok ? "ok opener started" : `fail ${String(opened.status)}`);
  await report();
}

export async function copyFixture(): Promise<void> {
  try {
    await navigator.clipboard.writeText("Mira fixture M-14");
    record("clipboard", "ok");
  } catch (error) {
    record("clipboard", `fail ${(error as Error).name}`);
  }
  await report();
}

/** U03, U04 (by hand), U06 and the PWA offer: what only a person can see, answered on the page. */
export async function observe(name: string, answer: "yes" | "no"): Promise<void> {
  record(`observed ${name}`, answer);
  await report();
}

const SHORTCUTS = new Set(["/", "Ctrl+K", "Ctrl+Enter", "Ctrl+Shift+Enter"]);

export function watchShortcuts(): void {
  window.addEventListener("keydown", (event) => {
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    const combo =
      (event.ctrlKey ? "Ctrl+" : "") + (event.shiftKey && key !== "/" ? "Shift+" : "") + key;
    if (!SHORTCUTS.has(combo)) return;
    event.preventDefault();
    record(`key ${combo}`, "ok reached the page");
    void report();
  });
}

/** Runs the session checks once. Returns whether the page holds a working session. */
export async function bootstrap(): Promise<boolean> {
  record("browser", await fullBrowserLabel());
  metric("viewport_w", window.innerWidth);
  metric("viewport_h", window.innerHeight);
  record("platform", platformLabel());
  record("secure context", isSecureContext ? "ok" : "fail");
  await redeem();
  const session = await api("/api/v1/session");
  record("session", session.ok ? "ok" : `fail ${String(session.status)}`);
  styleNonce();
  reactAriaNonce();
  trustedTypes();
  await serviceWorker();
  if (session.ok) await websocket();
  await report();
  return session.ok;
}
