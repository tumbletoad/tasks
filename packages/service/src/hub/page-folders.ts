// The page's folder chooser and a project's folder line: the folders in a folder on this computer,
// a new folder, and where a project's folders are. Only the person reaches these: the page's
// sign-in, or a person at a terminal. An agent's tools and a script get no way to list a person's
// disk through Tasks. The paths travel in request bodies only, never in a URL or a log line.
import { AppError } from "@tasks/contracts";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass } from "../ops/caller.ts";
import { findSpace, isAmbiguity } from "../ops/copies.ts";
import { folderState, openPath } from "../ops/folders.ts";
import type { OpsHost, ServedSpace } from "../ops/index.ts";
import {
  listFolders,
  makeFolder,
  nodeListFs,
  type KnownProject,
  type ListFs,
} from "../ops/listing.ts";
import { readProjectFolderAll, readProjectFolders } from "../ops/read.ts";

export interface PageFoldersHost {
  readonly ops: Pick<OpsHost, "machine" | "spaces" | "platform" | "home">;
  /** The disk as the chooser reads it. Default: this computer's. */
  readonly fs?: ListFs;
  /** How long one look may take. */
  readonly ms?: number;
}

/** One verb: its input, the caller's class, and the tab's space when the page names one. */
type Verb = (
  params: Record<string, unknown>,
  cls: ConnectionClass,
  space?: string,
) => Promise<unknown>;

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

function personOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can look through this computer's folders.",
      hint: "Ask the user to choose the folder.",
      data: { rule: "user_only" },
    });
  }
}

const pathOf = (params: Record<string, unknown>, key: string, required: boolean): string => {
  const value = params[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > 4096) throw invalid(key, "Expected a folder");
  return value;
};

export function pageFolderVerbs(host: PageFoldersHost): {
  readonly list: Verb;
  readonly make: Verb;
  readonly project: Verb;
} {
  const platform = host.ops.platform ?? process.platform;
  const fs = host.fs ?? nodeListFs(platform);
  const homeOf = (): string => {
    const home = host.ops.home;
    if (home === undefined) {
      throw new AppError({
        code: "service_unavailable",
        message: "This service knows no home folder, so it cannot look at folders.",
        data: { reason: "no_home", retryable: false },
      });
    }
    return home;
  };
  const served = (ref: string | undefined): ServedSpace | undefined => {
    if (ref === undefined) return undefined;
    const found = findSpace(
      host.ops.spaces().filter((s) => s.id !== undefined && s.reader !== undefined),
      ref,
    );
    return isAmbiguity(found) ? undefined : found;
  };
  /** The tab's space's projects with a folder here: a listed folder says which project has it. */
  const projectsOf = async (ref: string | undefined): Promise<KnownProject[]> => {
    const reader = served(ref)?.reader;
    if (reader === undefined) return [];
    try {
      const rows = await readProjectFolders(reader, host.ops.machine.id);
      return rows
        .filter((r) => !r.archived)
        .map((r) => ({ id: r.project, name: r.name, stored: r.stored }));
    } catch {
      return [];
    }
  };
  return {
    list: async (params, cls, space) => {
      personOnly(cls);
      const text = pathOf(params, "path", false);
      return listFolders(text, {
        home: homeOf(),
        platform,
        fs,
        projects: await projectsOf(space),
        ...(host.ms === undefined ? {} : { ms: host.ms }),
      });
    },
    make: async (params, cls) => {
      personOnly(cls);
      const text = pathOf(params, "path", true);
      return makeFolder(text, {
        home: homeOf(),
        platform,
        fs,
        ...(host.ms === undefined ? {} : { ms: host.ms }),
      });
    },
    project: async (params, cls, space) => {
      personOnly(cls);
      const project = params["project"];
      if (typeof project !== "string" || !/^p_[0-9a-z]{26}$/u.test(project)) {
        throw invalid("project", "Expected a project ID");
      }
      const reader = served(space)?.reader;
      if (reader === undefined) {
        throw new AppError({
          code: "space_unavailable",
          message: "This space is not open on this computer now.",
        });
      }
      const rows = await readProjectFolderAll(reader, project);
      const machine = host.ops.machine.id;
      const mine = rows.find((r) => r.machine === machine);
      const elsewhere = [
        ...new Set(rows.filter((r) => r.machine !== machine).map((r) => r.machineName)),
      ];
      if (mine === undefined) return { elsewhere };
      const home = host.ops.home;
      const state = await folderState(mine.stored, home, platform);
      const open = openPath(mine.stored, home, platform);
      const repo =
        state === "here" && open !== undefined
          ? await fs.repo(open).catch(() => undefined)
          : undefined;
      return {
        here: {
          folder: mine.stored,
          state,
          ...(repo === undefined ? {} : { repo }),
        },
        elsewhere,
      };
    },
  };
}
