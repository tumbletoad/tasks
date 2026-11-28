import type { Readiness } from "@ttasks/launch";

/** An instance's readiness in one line, with the next action when there is one. */
export function readinessText(ready: Readiness): string {
  if (ready.state === "not_installed") return `not installed: see ${ready.install}`;
  const installed = `installed ${ready.version ?? "(version unknown)"}`;
  switch (ready.state) {
    case "signed_in":
      return `${installed} · signed in`;
    case "signed_out":
      return `${installed} · not signed in: run ${ready.login}`;
    case "unknown":
      return `${installed} · sign-in unknown: run ${ready.status} to find out`;
  }
}
