// An agent home's rows in the grants table, found by the home itself: the app, the folder and the
// settings file a launch recorded at its click, against the rows setup made for that file. Paths
// are compared as setup compares them, since the row holds them as setup resolved them and the
// launch as the click named them.
import { isLive, type GrantStore } from "../local/index.ts";
import { folderFile, samePath } from "../setup/agents.ts";
import { isAgentApp } from "../setup/state.ts";

/** One of a home's rows: the instance its entry names, and whether it counts now. */
export interface HomeRow {
  readonly grant: string;
  readonly instance: string;
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
  /** The account's home folder, where Claude Code's default settings file is. */
  readonly userHome?: string;
}

/** What a click recorded of the agent it started: its app, folder and settings file. */
export interface ClickHome {
  readonly app: string;
  readonly home: string;
  /** Absent in a launch an earlier build recorded, which names a folder only. */
  readonly file?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The rows of the settings file a click recorded, revoked ones included. A row an earlier build
 * made names a folder only: it is the file that build gave the folder (setup's `folderFile`; setup
 * itself also reads its record, which the gate does not). A click an earlier build recorded names
 * a folder only, and has that folder's rows.
 */
export function homeRows(host: HomeRowsHost, click: ClickHome, now: Date = new Date()): HomeRows {
  let grants;
  try {
    grants = host.grants().list("agent_home");
  } catch {
    return { kind: "failed" };
  }
  const { platform } = host;
  const ofClick = (attrs: Readonly<Record<string, unknown>>): boolean => {
    const folder = text(attrs["home"]);
    const file = text(attrs["file"]);
    if (text(attrs["app"]) !== click.app || folder === "") return false;
    if (click.file === undefined) return samePath(platform, folder, click.home);
    if (file !== "") return samePath(platform, file, click.file);
    if (host.userHome === undefined || !isAgentApp(click.app)) {
      return samePath(platform, folder, click.home);
    }
    const earlier = folderFile({ platform, userHome: host.userHome }, click.app, folder);
    return samePath(platform, earlier, click.file);
  };
  const rows = grants
    .filter((grant) => ofClick(grant.attrs))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map((grant) => ({
      grant: grant.grant_id,
      instance: text(grant.attrs["instance"]),
      spaces: grant.spaces,
      live: isLive(grant, now),
    }));
  return { kind: "rows", rows };
}
