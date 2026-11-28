import type { Readiness } from "@ttasks/launch";

/** What an instance's app reported about itself, in one line, with the next step when there is one. */
export function readinessText(ready: Readiness): string {
  if (ready.state === "not_installed") return `not installed: see ${ready.install}`;
  const installed = `installed ${ready.version ?? "(version unknown)"}`;
  switch (ready.state) {
    case "login_found":
      return `${installed} · the app found a login for this home`;
    case "no_login":
      return `${installed} · the app found no confirmed login for this home. ${
        ready.login === undefined
          ? "Sign in with the app's own login command"
          : `To sign in, run: ${ready.login}`
      } (a key in the environment or a gateway also works without a login)`;
    case "unknown":
      return `${installed} · login not known${
        ready.status === undefined ? "" : `: run ${ready.status} to find out`
      }`;
  }
}
