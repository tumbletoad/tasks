// The page's entry (A2 3.8.4): before any request, the fragment is read and removed from the URL,
// so the one-time code never reaches the server, the history or a log. Then the code is redeemed
// for a token, the token is kept (and a stored one is read as untrusted), and the router takes the
// tab's route, which names its space.
//
// The styles, in order: the bundled faces (A5 3.20; fetched only from this origin), the theme
// tokens the build writes from the theme data, the global sheet. The components' CSS Modules follow
// with their components.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fira-code/wght.css";
import "virtual:theme-tokens.css";
import "./theme/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { redeem } from "./api.ts";
import { App } from "./app/App.tsx";
import { I18n } from "./i18n/intl.tsx";
import { pagePath, readFragment } from "./route.ts";
import { browserStore, keepToken, readToken } from "./stored.ts";

/** The build of the service that served this page (its `__TTASKS_BUILD__`), or "" from a dev build. */
function servedBuild(): string {
  const value = document.querySelector('meta[name="app-build"]')?.getAttribute("content") ?? "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.startsWith("__") ? value : "";
}

const store = browserStore();

const fragment = readFragment(location.hash);
const path = pagePath(location.pathname);
const target = fragment.to ?? (path === undefined ? "/" : `${path}${location.search}`);
// The fragment goes before anything else runs: the code is in no later URL, request or history.
if (location.hash !== "" || target !== `${location.pathname}${location.search}`) {
  history.replaceState(null, "", target);
}

const container = document.getElementById("root");
if (container === null) throw new Error("The page has no root element");
const root = createRoot(container);

async function start(): Promise<void> {
  let token = readToken(store);
  if (fragment.code !== undefined) {
    const redeemed = await redeem(fragment.code).catch(() => null);
    if (redeemed !== null) {
      token = redeemed;
      keepToken(store, redeemed);
    }
  }
  root.render(
    <StrictMode>
      <I18n>
        <App token={token} build={servedBuild()} store={store} />
      </I18n>
    </StrictMode>,
  );
}

void start();
