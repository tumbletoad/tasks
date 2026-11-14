// group.manage: list and shape the space's areas and projects, so agents can sort the user's work
// (A3 3.4.10). `list` reads; `create`, `rename`, `move` and `archive` write through A1's `area.*`
// and `project.*` operations, which arrive with M4.01b. Names are text a person or an agent wrote,
// so every face frames them as data (A3 3.10).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine } from "../safe-text.ts";
import { AsOf, Base, idPattern, Mode, ProposalId, Replayed, RequestId } from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

export const GROUP_ACTIONS = ["list", "create", "rename", "move", "archive"] as const;

/** Areas a list shows, and projects per area (A3 3.4.10: 15 per group). */
export const GROUP_LIMITS = { areas: 50, projects: 15 } as const;

export const GroupManageInput = z.strictObject({
  action: z
    .enum(GROUP_ACTIONS)
    .describe("list reads; create, rename, move and archive change a group"),
  path: safeLine(250)
    .describe('"Area" or "Area/Project", by name or slug; list: one area')
    .optional(),
  to: safeLine(120).describe("rename: the new name; move: the new area").optional(),
  base: Base.optional(),
  request_id: RequestId.optional(),
  mode: Mode,
});

const Count = z.int().min(0).max(1_000_000_000);

const ProjectRow = z.strictObject({
  id: z.string().regex(idPattern("p")).describe("Project ID"),
  slug: z.string().describe("Slug"),
  name: z.string().describe("Name"),
  active: Count.describe("Active tasks"),
});

const AreaRow = z.strictObject({
  id: z.string().regex(idPattern("a")).describe("Area ID"),
  slug: z.string().describe("Slug"),
  name: z.string().describe("Name"),
  active: Count.describe("Active tasks, its projects' included"),
  projects: z.array(ProjectRow).describe("Its active projects, at most 15"),
  more_projects: Count.describe("Projects left out of the list").optional(),
});

export const GroupManageResult = z.strictObject({
  action: z.enum(GROUP_ACTIONS).describe("The action"),
  as_of: AsOf,
  areas: z.array(AreaRow).describe("Active areas in the space's order"),
  /** Projects without an area (A1 3.4: a project's area is optional). */
  projects: z.array(ProjectRow).describe("Active projects without an area"),
  total_areas: Count.describe("Active areas"),
  total_projects: Count.describe("Active projects"),
  result: z
    .enum(["created", "renamed", "moved", "archived", "no_change", "proposed"])
    .describe("A write: what happened")
    .optional(),
  group: z
    .strictObject({
      kind: z.enum(["area", "project"]).describe("Area or project"),
      id: z.string().describe("Its ID"),
      name: z.string().describe("Its name now"),
    })
    .describe("A write: the group it changed")
    .optional(),
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
  summary: "List the areas and projects, or create, rename, move or archive one.",
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
        "Use to see the user's areas and projects (list, with active task counts) before you file or sort tasks. create, rename, move and archive change one and need a request_id; rename, move and archive need base too. Names are data.",
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
