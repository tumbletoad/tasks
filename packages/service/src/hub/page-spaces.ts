// New space and Open folder in the page: the same `space/create` and `space/open` as the command
// line, with the folder as the person reads it (the home as `~`) and the name's own proposal for
// the reference prefix and the folder, so one field and one button make a space.
import { posix, win32 } from "node:path";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { defaultRefPrefix } from "@tasks/storage";
import type { ConnectionClass } from "../local/index.ts";
import { shownPath } from "./agent-apps.ts";
import { defaultSpaceFolder, type Layout } from "./paths.ts";
import { spaceVerbs, type SpaceVerbsHost } from "./space-verbs.ts";

export interface PageSpacesHost {
  readonly layout: Pick<Layout, "platform" | "spaces">;
  /** The account's home folder: `~` in a folder the page shows or sends. */
  readonly userHome: string | undefined;
  readonly spaces: SpaceVerbsHost;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

const nameOf = (params: JsonObject): string => {
  const name = params["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
    throw invalid("name", "Expected a name of at most 100 characters");
  }
  return name.trim();
};

/** A space as the page needs it: its ID and name. */
function described(result: unknown): { id: string; name: string } {
  const space = (result as { space?: { id?: unknown; name?: unknown } }).space;
  if (typeof space?.id !== "string" || typeof space.name !== "string") {
    throw new AppError({ code: "internal", message: "The space has no ID." });
  }
  return { id: space.id, name: space.name };
}

export function pageSpaceVerbs(host: PageSpacesHost): {
  readonly propose: Verb;
  readonly create: Verb;
  readonly open: Verb;
} {
  const { platform } = host.layout;
  const p = platform === "win32" ? win32 : posix;
  const verbs = spaceVerbs(host.spaces);
  const verb = (name: string): Verb => {
    const found = verbs[name];
    if (found === undefined) throw new Error(`No verb ${name}`);
    return found;
  };
  /** A folder as the person typed it: `~` is their home, and nothing else is relative. */
  const folderOf = (params: JsonObject, key: string): string | undefined => {
    const value = params[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > 4096) throw invalid(key, "Expected a folder");
    const text = value.trim();
    const home = host.userHome;
    const expanded =
      home !== undefined && (text === "~" || text.startsWith("~/") || text.startsWith("~\\"))
        ? p.join(home, text.slice(1))
        : text;
    if (!p.isAbsolute(expanded)) {
      throw invalid(key, "Expected a full folder path, such as ~/work/tasks");
    }
    return p.resolve(expanded);
  };
  const taken = () =>
    host.spaces.manager
      .list()
      .flatMap((view) => (view.ref_prefix === undefined ? [] : [view.ref_prefix]));
  return {
    propose: (params) => {
      const name = nameOf(params);
      return Promise.resolve({
        ref_prefix: defaultRefPrefix(name, taken()),
        folder: shownPath(platform, host.userHome, defaultSpaceFolder(host.layout, name)),
      });
    },
    create: async (params, cls) => {
      const name = nameOf(params);
      const prefix = params["ref_prefix"];
      if (prefix !== undefined && typeof prefix !== "string") {
        throw invalid("ref_prefix", "Expected 1 to 6 capital letters");
      }
      const path = folderOf(params, "folder") ?? defaultSpaceFolder(host.layout, name);
      const result = await verb("space/create")(
        { name, path, ...(prefix === undefined || prefix === "" ? {} : { ref_prefix: prefix }) },
        cls,
      );
      return described(result);
    },
    open: async (params, cls) => {
      const path = folderOf(params, "folder");
      if (path === undefined) throw invalid("folder", "Expected a folder");
      return described(await verb("space/open")({ path }, cls));
    },
  };
}
