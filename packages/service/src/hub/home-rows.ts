// An agent home's rows in the grants table, found by the home itself: the app and the folder a
// launch recorded at its click, against the rows setup made for that home. The folder is compared
// as setup compares it (one live row per app and home, hub/agent-homes.ts), since the row holds the
// folder as setup resolved it and the launch as the click named it.
import { isLive, type GrantStore } from "../local/index.ts";
import { samePath } from "../setup/agents.ts";
import { rowRegistration } from "./home-gate.ts";

/** One of a home's rows: the instance and registration its entry names, and whether it counts now. */
export interface HomeRow {
  readonly grant: string;
  readonly instance: string;
  /** The registration's ID; undefined for a row an earlier build made. */
  readonly registration: string | undefined;
  readonly spaces: readonly string[];
  /** Neither revoked nor expired. */
  readonly live: boolean;
}

/**
 * A home's rows, newest first: none when the home was never registered. A grants table that could
 * not be read is `failed`, never a home without rows.
 */
export type HomeRows =
  { readonly kind: "rows"; readonly rows: readonly HomeRow[] } | { readonly kind: "failed" };

export interface HomeRowsHost {
  grants(): Pick<GrantStore, "list">;
  readonly platform: NodeJS.Platform;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The rows of the home `home` of `app`, revoked ones included. */
export function homeRows(
  host: HomeRowsHost,
  app: string,
  home: string,
  now: Date = new Date(),
): HomeRows {
  let grants;
  try {
    grants = host.grants().list("agent_home");
  } catch {
    return { kind: "failed" };
  }
  const rows = grants
    .filter(
      (grant) =>
        text(grant.attrs["app"]) === app &&
        text(grant.attrs["home"]) !== "" &&
        samePath(host.platform, text(grant.attrs["home"]), home),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map((grant) => ({
      grant: grant.grant_id,
      instance: text(grant.attrs["instance"]),
      registration: rowRegistration(grant.attrs),
      spaces: grant.spaces,
      live: isLive(grant, now),
    }));
  return { kind: "rows", rows };
}
