// folder.manage: the person's own folders on this machine, for a project or a task. `add_project`
// makes a project for a folder (or names the project that has it already), `set` gives a project
// or a task its folder here, and `clear` takes it away. The person's only for now: an agent's
// folder fields come with the agent tools' own step. A folder is an absolute path on this machine,
// or one under `~`; the service stores it with the home written as `~` and checks it at bind: it
// exists and is a folder, it is not inside TTasks's own data, and no other live project has it here.
// A folder changed after it was moved takes every folder inside it along.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine } from "../safe-text.ts";
import {
  AsOf,
  Base,
  idPattern,
  InsideFolders,
  ProjectArea,
  Compared,
  Replayed,
  RequestId,
  TaskRef,
  TaskRefInput,
} from "../schemas.ts";
import { requestId } from "./fixture.ts";

export const FOLDER_ACTIONS = ["add_project", "set", "clear"] as const;

export const FolderManageInput = z.strictObject({
  action: z
    .enum(FOLDER_ACTIONS)
    .describe("add_project makes a project for a folder; set and clear a project's or a task's"),
  project: safeLine(250)
    .describe('set, clear: "Area/Project", a name, slug or ID; add_project: name or folder\'s')
    .optional(),
  task: TaskRefInput.describe("set, clear: the task, such as M-14").optional(),
  area: safeLine(120).describe("add_project: the new project's area, by name").optional(),
  folder: z
    .string()
    .min(1)
    .max(4096)
    .describe("add_project, set: an absolute folder on this machine, or one under ~")
    .optional(),
  base: Base.optional(),
  request_id: RequestId,
});

export const FolderManageResult = z.strictObject({
  action: z.enum(FOLDER_ACTIONS).describe("The action"),
  result: z
    .enum(["created", "exists", "set", "cleared", "no_change"])
    .describe("What happened; exists: another project has this folder here"),
  owner: z
    .strictObject({
      kind: z.enum(["project", "task"]).describe("Project or task"),
      id: z.string().regex(idPattern("[pt]")).describe("Its ID"),
      name: z.string().describe("A project's name").optional(),
      ref: TaskRef.optional(),
      area: ProjectArea.optional(),
    })
    .describe("Whose folder it is"),
  folder: z
    .string()
    .max(4096)
    .describe("The folder here as stored, the home as ~; absent once cleared")
    .optional(),
  ...InsideFolders,
  as_of: AsOf,
  replayed: Replayed.optional(),
  compared: Compared.optional(),
});

export const folderManage = defineEntry({
  name: "folder.manage",
  summary: "Give a project or a task its folder on this machine, or make a project for a folder.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "never",
  audience: "none",
  ops: [
    "area.create",
    "project.create",
    "project.folder_set",
    "project.folder_clear",
    "task.folder_set",
    "task.folder_clear",
  ],
  input: FolderManageInput,
  output: FolderManageResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "ambiguous",
    "conflict",
    "forbidden",
    "space_unavailable",
    "read_only",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "A project for the portal's folder",
      actor: "user",
      input: {
        action: "add_project",
        project: "Portal",
        area: "Client work",
        folder: "~/work/lumen/portal",
        request_id: requestId(61),
      },
      output: {
        action: "add_project",
        result: "created",
        owner: { kind: "project", id: "p_4g8k2m6q0s4w8y2b6d0f4h8k2m", name: "Portal" },
        folder: "~/work/lumen/portal",
        as_of: "1.1050.5n0w8k3q",
      },
    },
  ],
});
