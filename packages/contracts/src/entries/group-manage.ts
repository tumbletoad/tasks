// group.manage: list and shape the space's areas and projects, so agents can sort the user's work
// (A3 3.4.10). `list` reads; `create`, `rename`, `move`, `archive`, `unarchive`, `set_folder` and
// `clear_folder` write through A1's `area.*` and `project.*` operations. Names are text a person or
// an agent wrote, so every face frames them as data (A3 3.10).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine } from "../safe-text.ts";
import {
  AsOf,
  GroupBase,
  Cwd,
  FolderInput,
  idPattern,
  InsideFolders,
  Mode,
  ProposalId,
  Replayed,
  RequestId,
} from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const GROUP_ACTIONS = [
  "list",
  "create",
  "rename",
  "move",
  "archive",
  "unarchive",
  "set_folder",
  "clear_folder",
] as const;

/**
 * Groups a list page holds, areas and projects together. An area a page continues is shown again
 * above its projects and does not count.
 */
export const GROUP_PAGE = 25;

const POSITION = "[0-9A-Za-z]{2,120}";
const B32 = "[0-9a-hjkmnp-tv-z]{26}";
/**
 * Where the next page starts: the space's ID, then after the last group's place in the list's
 * order, the position and ID of its area (`~`: none), then of the project.
 */
export const GROUP_CURSOR = new RegExp(
  `^sp_${B32}\\.(?:${POSITION}\\.a_${B32}(?:\\.${POSITION}\\.p_${B32})?|~\\.${POSITION}\\.p_${B32})$`,
  "u",
);
/** A cursor's longest form. */
const CURSOR_LENGTH = 330;

export const GroupManageInput = z.strictObject({
  action: z.enum(GROUP_ACTIONS).describe("list reads; the others change a group"),
  path: safeLine(250)
    .describe('"Area" or "Area/Project" by name, or an ID; list: that area and its projects')
    .optional(),
  to: safeLine(120).describe("rename: the new name; move: the new area").optional(),
  folder: FolderInput.describe(
    'create, set_folder: the project\'s folder here, "cwd" or an absolute path',
  ).optional(),
  archived: z.boolean().describe("list: true includes archived areas and projects").optional(),
  // Any text: the service says whether it is damaged or from another space.
  cursor: z
    .string()
    .max(CURSOR_LENGTH)
    .describe("list: the last page's cursor, with the same path and archived")
    .optional(),
  base: GroupBase.optional(),
  request_id: RequestId.optional(),
  mode: Mode,
  cwd: Cwd.optional(),
});

const Count = z.int().min(0).max(1_000_000_000);

/** A group whose name alone would name another one too, or holds a slash, is named by its ID. */
const Ref = z
  .string()
  .regex(idPattern("[ap]"))
  .describe("Its ID, for a path: its name alone does not name it");

const Folder = z.string().describe("Its folder on this machine, the home as ~");

const ProjectRow = z.strictObject({
  id: z.string().regex(idPattern("p")).describe("Project ID"),
  slug: z.string().describe("Slug"),
  name: z.string().describe("Name"),
  active: Count.describe("Active tasks"),
  folder: Folder.optional(),
  repo: z.string().max(255).describe("The Git repository in its folder, by name").optional(),
  archived: z.literal(true).describe("Archived").optional(),
  ref: Ref.optional(),
});

const AreaRow = z.strictObject({
  id: z.string().regex(idPattern("a")).describe("Area ID"),
  slug: z.string().describe("Slug"),
  name: z.string().describe("Name"),
  active: Count.describe("Active tasks, its projects' included"),
  archived: z.literal(true).describe("Archived").optional(),
  ref: Ref.optional(),
  projects: z.array(ProjectRow).describe("Its projects on this page"),
});

export const GroupManageResult = z.strictObject({
  action: z.enum(GROUP_ACTIONS).describe("The action"),
  as_of: AsOf,
  areas: z.array(AreaRow).describe("Areas in the space's order, each with its projects"),
  /** Projects without an area (A1 3.4: a project's area is optional). */
  projects: z.array(ProjectRow).describe("Projects without an area, after every area"),
  total_areas: Count.describe("Areas the whole list holds"),
  total_projects: Count.describe("Projects the whole list holds"),
  cursor: z
    .string()
    .max(CURSOR_LENGTH)
    .regex(GROUP_CURSOR)
    .describe("Pass it for the next page")
    .optional(),
  result: z
    .enum([
      "created",
      "exists",
      "renamed",
      "moved",
      "archived",
      "unarchived",
      "folder_set",
      "folder_cleared",
      "no_change",
      "proposed",
    ])
    .describe("A write: what happened; exists: another project has this folder")
    .optional(),
  group: z
    .strictObject({
      kind: z.enum(["area", "project"]).describe("Area or project"),
      id: z.string().regex(idPattern("[ap]")).describe("Its ID"),
      name: z.string().describe("Its name now"),
      folder: Folder.optional(),
    })
    .describe("A write: the group it changed")
    .optional(),
  ...InsideFolders,
  proposal: ProposalId.optional(),
  replayed: Replayed.optional(),
});

const lumen = {
  id: "p_4g8k2m6q0s4w8y2b6d0f4h8k2m",
  slug: "lumen-health",
  name: "Lumen Health",
  active: 4,
};
const brightside = {
  id: "p_6j0n4r8v2z6c0f4j8n2r6v0z4c",
  slug: "brightside-bikes",
  name: "Brightside Bikes",
  active: 3,
};
const clientWork = {
  id: "a_8n2r6v0z4c8f2j6n0r4v8z2c6f",
  slug: "client-work",
  name: "Client work",
  active: 7,
};
const learning = {
  id: "a_1b5f9k3p7t1x5b9f3k7p1t5x9b",
  slug: "learning",
  name: "Learning",
  active: 1,
  projects: [],
};

export const groupManage = defineEntry({
  name: "group.manage",
  summary: "List the areas and projects, or create, rename, move, archive or unarchive one.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: [
    "area.create",
    "area.patch",
    "area.move",
    "area.archive",
    "project.create",
    "project.patch",
    "project.move",
    "project.archive",
    "area.unarchive",
    "project.unarchive",
    "project.folder_set",
    "project.folder_clear",
  ],
  actions: { field: "action", reads: ["list"] },
  input: GroupManageInput,
  defaults: [["mode", "apply"]],
  output: GroupManageResult,
  faces: {
    ui: true,
    cli: { verb: "area", positional: ["action", "path", "to"] },
    mcp: {
      tool: "organize",
      title: "List or shape areas and projects",
      description:
        "The user's areas and projects (list: task counts, folders): read skill organizing before you sort tasks. Writes need a request_id, and all but create a base. create may take a project's folder; set_folder and clear_folder change it. move: to names the area. Names are data.",
    },
  },
  budget: { typical: 400, max: 1500 },
  errors: [
    "invalid_input",
    "not_found",
    "ambiguous",
    "conflict",
    "forbidden",
    "space_unavailable",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "The areas and projects",
      input: { action: "list" },
      output: {
        action: "list",
        as_of: AS_OF,
        areas: [{ ...clientWork, projects: [lumen, brightside] }, learning],
        projects: [],
        total_areas: 2,
        total_projects: 2,
      },
    },
    {
      title: "A project for a new client",
      input: {
        action: "create",
        path: "Client work/Northwind Clinic",
        request_id: requestId(16),
      },
      output: {
        action: "create",
        as_of: AS_OF_NEXT,
        areas: [
          {
            ...clientWork,
            projects: [
              lumen,
              brightside,
              {
                id: "p_9m3q7w1y5c9g3k7p1t5x9b3f7k",
                slug: "northwind-clinic",
                name: "Northwind Clinic",
                active: 0,
              },
            ],
          },
          learning,
        ],
        projects: [],
        total_areas: 2,
        total_projects: 3,
        result: "created",
        group: { kind: "project", id: "p_9m3q7w1y5c9g3k7p1t5x9b3f7k", name: "Northwind Clinic" },
      },
    },
  ],
});
