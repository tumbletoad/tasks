// Where a task opens on this machine, as `task.get`'s digest says it: its own folder or its
// project's, in stored form, whether it is missing now and the Git repository it holds; or the
// machine its folder is on. Both backends' digests say it with this one function.
import { folderState, openPath } from "./folders.ts";
import type { TaskFolder } from "./read.ts";
import { repoName } from "./repo.ts";
import type { DigestFolder } from "./task-view.ts";

export async function digestFolderOf(
  host: { readonly platform?: NodeJS.Platform; readonly home?: string },
  folder: TaskFolder,
): Promise<DigestFolder | undefined> {
  switch (folder.kind) {
    case "task":
    case "project": {
      const platform = host.platform ?? process.platform;
      const state = await folderState(folder.path, host.home, platform);
      const open = openPath(folder.path, host.home, platform);
      const repo =
        state === "missing" || open === undefined ? undefined : await repoName(open, platform);
      return {
        path: folder.path,
        of: folder.kind,
        ...(state === "missing" ? { missing: true } : {}),
        ...(repo === undefined ? {} : { repo }),
      };
    }
    case "other_machine":
      return { machine: folder.machine };
    case "none":
      return undefined;
  }
}
