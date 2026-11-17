// Which folders an import gives on the machine that applies it. Pure: the service looks at each
// task's folder on its disk (FolderFact) and reads the live projects' folders there, and this
// module decides.
//
// - A task's folder is its first absolute path, when that is a folder on this machine.
// - A project gets the folder of one of its tasks that holds every other task folder of the
//   project; a task whose folder is exactly that one gets none of its own. Without such a folder
//   the project gets none, and each task keeps its own.
// - Two live projects never share a folder on one machine: a folder another project has here, or
//   that a project earlier in the import gets, gives the later project none. Nested folders are
//   fine.
//
// Folders compare as the space stores them, by whole names with the machine's case rule.
import { METADATA_FILE } from "./metadata.ts";
import type { ImportPlan } from "./plan.ts";
import { problem, type Problem } from "./problems.ts";

export type FolderOs = "linux" | "windows" | "macos";

/** What this machine says of a task's folder path. */
export type FolderFact =
  | { readonly state: "present"; readonly stored: string }
  /** Not there, not a folder, or not answering. */
  | { readonly state: "missing" }
  /** A path of another kind of machine: a drive path on Linux, a POSIX path on Windows. */
  | { readonly state: "other_machine" }
  /** Inside the app's own data. */
  | { readonly state: "reserved" };

/** A live project's folder on this machine. */
export interface ProjectFolderRow {
  readonly project: string;
  readonly title: string;
  /** As stored. */
  readonly path: string;
}

export type ProjectFolderNone = "no_folders" | "no_common_folder" | "taken";

export type ProjectFolder =
  { readonly folder: string } | { readonly none: ProjectFolderNone; readonly holder?: string };

/** What becomes of a task's folder path. `path` is the stored form when it is a folder here. */
export interface TaskFolder {
  readonly path: string;
  readonly state: "own" | "project" | "missing" | "other_machine" | "reserved";
}

export interface FolderDecision {
  /** By planned project slug. */
  readonly projects: ReadonlyMap<string, ProjectFolder>;
  /** By legacy ID, for each task with a folder path. */
  readonly tasks: ReadonlyMap<string, TaskFolder>;
  /** `folder-missing`, `folder-reserved` and `folder-taken`. */
  readonly problems: readonly Problem[];
}

/** A stored folder's names as the machine compares them: a root is no name. */
export function folderNames(path: string, os: FolderOs): string[] {
  const names = path.split(os === "windows" ? "\\" : "/").filter((s) => s !== "");
  return os === "linux" ? names : names.map((s) => s.toLowerCase());
}

/** Whether `inner` is `outer` or inside it, by whole names. */
export function within(inner: string, outer: string, os: FolderOs): boolean {
  const a = folderNames(inner, os);
  const b = folderNames(outer, os);
  return a.length >= b.length && b.every((name, i) => a[i] === name);
}

const sameFolder = (a: string, b: string, os: FolderOs): boolean =>
  within(a, b, os) && within(b, a, os);

/**
 * The folders of an import (the module header). `facts` holds what this machine says of each
 * task's folder path, by legacy ID; a task without one is missing. `holders` are the live
 * projects' folders here, and `reuses` gives the space's project a planned project goes to: its own
 * folder is no other project's.
 */
export function decideFolders(
  plan: Pick<ImportPlan, "tasks" | "projects">,
  facts: ReadonlyMap<string, FolderFact>,
  options: {
    readonly os: FolderOs;
    readonly holders: readonly ProjectFolderRow[];
    readonly reuses: (planSlug: string) => string | undefined;
  },
): FolderDecision {
  const { os } = options;
  const tasks = new Map<string, TaskFolder>();
  const problems: Problem[] = [];
  /** The tasks with a folder here, by planned project slug. */
  const byProject = new Map<string, { legacyId: string; stored: string; index: number }[]>();
  const present = new Map<string, string>();
  for (const t of plan.tasks) {
    if (t.folder === undefined) continue;
    const fact = facts.get(t.legacyId) ?? { state: "missing" };
    const at = { file: METADATA_FILE, task: t.legacyId, field: "paths" as const };
    if (fact.state !== "present") {
      tasks.set(t.legacyId, { path: t.folder.path, state: fact.state });
      const code = fact.state === "reserved" ? "folder-reserved" : "folder-missing";
      problems.push(problem(code, { ...at, index: t.folder.index }));
      continue;
    }
    present.set(t.legacyId, fact.stored);
    if (t.project === undefined) continue;
    const list = byProject.get(t.project) ?? [];
    list.push({ legacyId: t.legacyId, stored: fact.stored, index: t.folder.index });
    byProject.set(t.project, list);
  }

  const projects = new Map<string, ProjectFolder>();
  /** The folders projects earlier in the import get, with their titles. */
  const given: { path: string; title: string }[] = [];
  for (const p of plan.projects) {
    const list = byProject.get(p.slug) ?? [];
    if (list.length === 0) {
      projects.set(p.slug, { none: "no_folders" });
      continue;
    }
    const outer = list.find((c) => list.every((t) => within(t.stored, c.stored, os)));
    if (outer === undefined) {
      projects.set(p.slug, { none: "no_common_folder" });
      continue;
    }
    const own = options.reuses(p.slug);
    const holder =
      options.holders.find((h) => h.project !== own && sameFolder(h.path, outer.stored, os))
        ?.title ?? given.find((g) => sameFolder(g.path, outer.stored, os))?.title;
    if (holder !== undefined) {
      projects.set(p.slug, { none: "taken", holder });
      problems.push(
        problem("folder-taken", {
          file: METADATA_FILE,
          task: outer.legacyId,
          field: "paths",
          index: outer.index,
        }),
      );
      continue;
    }
    projects.set(p.slug, { folder: outer.stored });
    given.push({ path: outer.stored, title: p.title });
  }

  for (const t of plan.tasks) {
    const stored = present.get(t.legacyId);
    if (stored === undefined) continue;
    const of = t.project === undefined ? undefined : projects.get(t.project);
    const theirs = of !== undefined && "folder" in of && sameFolder(of.folder, stored, os);
    tasks.set(t.legacyId, { path: stored, state: theirs ? "project" : "own" });
  }
  return { projects, tasks, problems };
}

/** The folder a task's own folder field takes: its folder when it is its own, else none. */
export const ownFolder = (decision: FolderDecision, legacyId: string): string | null => {
  const t = decision.tasks.get(legacyId);
  return t?.state === "own" ? t.path : null;
};

/** The folder a planned project gets, or none. */
export const projectFolder = (decision: FolderDecision, planSlug: string): string | null => {
  const p = decision.projects.get(planSlug);
  return p !== undefined && "folder" in p ? p.folder : null;
};

/** What the token pins of the decision: the folders the apply writes, in plan order. */
export function pinnedFolders(
  plan: Pick<ImportPlan, "tasks" | "projects">,
  decision: FolderDecision,
): unknown[] {
  return [
    ...plan.projects.map((p) => ["project", p.slug, projectFolder(decision, p.slug)]),
    ...plan.tasks.flatMap((t) =>
      t.folder === undefined ? [] : [["task", t.legacyId, ownFolder(decision, t.legacyId)]],
    ),
  ];
}
