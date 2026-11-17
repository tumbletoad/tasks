// import.planning.preview: the dry run of the Planning prototype import (A7 3.15.4). The user's
// only (A3 3.2.3, `import.planning.*`): the CLI's `tasks import planning <folder> --dry-run` and,
// with M5.12, first-run step 6 and Settings › Data call it. It copies the prototype's inputs into a
// run folder in the space (A7 3.15.1), parses the copy, plans the import, judges the plan against
// the space and this machine, writes `report.md` and `report.json` beside the copy, and returns
// the report with a preview token, which the apply (M7.05) needs. It writes no operation: the run
// folder is all it adds, so it is a read. A report with an error has no token: every error blocks.
//
// The report never holds a problem's input text (import-planning.ts). It does hold the person's own
// words where the report is about them (area, project and owner names), which only the user reads.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { IMPORT_PROBLEM_CODES, ImportProblem, type ImportProblemCode } from "../import-planning.ts";

const Count = z.int().min(0).max(1_000_000_000);
/** An absolute path on this machine, as the CLI resolves it. */
const Path = z.string().min(1).max(4096);
/** The run's ID: the ID of the exchange the apply records for it (A1 3.14). */
export const IMPORT_RUN = /^ex_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
/** `pv1_` and the base64url SHA-256 of what the preview pins (A7 3.15.4). */
export const PREVIEW_TOKEN = /^pv1_[A-Za-z0-9_-]{43}$/u;
/** At most this many rows of tasks and of problems in a result; report.json holds every one. */
export const PREVIEW_ROWS = 2_000;

const codes = Object.keys(IMPORT_PROBLEM_CODES) as [ImportProblemCode, ...ImportProblemCode[]];

export const ImportPlanningPreviewInput = z.strictObject({
  folder: Path.describe("The prototype folder, an absolute path"),
  me: z.string().min(1).max(300).describe("The owner name that is you: no owner").optional(),
  actions: Path.describe("The page's actions export, an absolute path").optional(),
  checked_as: z
    .enum(["completed", "review"])
    .describe("A checked task: completed (default) or kept in Review")
    .optional(),
  include_orphans: z
    .boolean()
    .describe("Create metadata entries without a task line, in Backlog")
    .optional(),
});

export const ImportPlanningCounts = z.strictObject({
  todo_task_lines: Count.describe("Task lines in TODO.md"),
  done_task_lines: Count.describe("Task lines in DONE.md"),
  task_lines: Count.describe("Task lines in both"),
  metadata_entries: Count.describe("Entries of data/metadata.json"),
  metadata_orphans: Count.describe("Metadata entries without a task line"),
  task_lines_without_metadata: Count.describe("Task lines without a metadata entry"),
  event_files: Count.describe("events/*.json files"),
  ready_files: Count.describe("events/*.ready files"),
  counted_event_files: Count.describe("Event files that count by the .ready rule"),
  events_not_ready: Count.describe("web- event files without .ready: skipped"),
  actions_events: Count.describe("Events in the actions export"),
  actions_added: Count.describe("Of those, events added to those of events/"),
  tasks: Count.describe("Tasks to create"),
  active: Count.describe("Of those, active"),
  completed: Count.describe("Of those, completed"),
  wrapped: Count.describe("Of the completed, wrapped up with an outcome"),
  aliases: Count.describe("Legacy IDs kept as aliases"),
  areas: Count.describe("Areas the import names"),
  areas_existing: Count.describe("Of those, ones the space has: reused"),
  projects: Count.describe("Projects the import names"),
  projects_existing: Count.describe("Of those, ones the space has: reused"),
  sources: Count.describe("Distinct sources"),
  sources_existing: Count.describe("Of those, keys the space holds: linked"),
  links: Count.describe("Links from tasks to sources"),
  folders: Count.describe("Tasks with a folder in the prototype"),
  folders_missing: Count.describe("Of those, not a folder on this machine"),
  project_folders: Count.describe("Projects that get a folder on this machine"),
  duplicates_left_out: Count.describe("Task lines left out for an ID another line has"),
  orphans_included: Count.describe("Metadata entries without a task line, created"),
  text_sanitised: Count.describe("Fields whose text the sanitiser changed"),
  source_changes: Count.describe("Inputs that changed during the run: must be 0"),
});

/** What becomes of a task's folder: the first absolute path the prototype gives it. */
const TaskFolder = z.strictObject({
  path: z
    .string()
    .describe("The folder as stored here, the home as ~; else as the prototype has it"),
  // own: the task's folder; project: its project's, so none of its own; missing: no folder here;
  // other_machine: a path of another kind of machine; reserved: inside the app's own data.
  state: z
    .enum(["own", "project", "missing", "other_machine", "reserved"])
    .describe("Its own, its project's, or why none: missing, other_machine, reserved"),
});

/** Why a project gets no folder. */
export const PROJECT_FOLDER_NONE = ["no_folders", "no_common_folder", "taken"] as const;

export const ImportPlanningPreviewResult = z.strictObject({
  run: z.string().regex(IMPORT_RUN).describe("The run: --apply names it"),
  folder: z.string().describe("The run's folder in the space: input copy and reports"),
  source: z
    .strictObject({
      folder: z.string().describe("The prototype folder, as copied"),
      actions: z.string().describe("The actions export, as copied").optional(),
    })
    .describe("What was copied: the apply checks it again"),
  blocked: z.boolean().describe("An error blocks the preview: no token"),
  token: z.string().regex(PREVIEW_TOKEN).describe("The preview token --apply needs").optional(),
  time_zone: z.string().describe("IANA zone the days are placed in"),
  options: z
    .strictObject({
      me: z.string().describe("--me").optional(),
      checked_as: z.enum(["completed", "review"]).describe("--checked-as"),
      include_orphans: z.boolean().describe("--include-orphans"),
    })
    .describe("The options the plan was made with"),
  counts: ImportPlanningCounts.describe("Counts and reconciliation"),
  reconciled: z.boolean().describe("Every task line is one task or a left-out duplicate"),
  sources_by_kind: z
    .array(
      z.strictObject({
        kind: z.string().describe("Source kind"),
        count: Count.describe("Sources"),
      }),
    )
    .describe("Sources per kind"),
  statuses: z
    .array(
      z.strictObject({
        prototype: z
          .enum(["open", "waiting", "needs_review", "delegated", "backlog", "none"])
          .describe("The prototype's status, none without one"),
        status: z.enum(["open", "waiting", "review", "backlog"]).describe("Its status here"),
        count: Count.describe("Tasks"),
      }),
    )
    .describe("Status mapping"),
  project_folders: z
    .array(
      z.strictObject({
        project: z.string().describe("Project title"),
        area: z.string().describe("Its area's title"),
        folder: z.string().describe("The folder it gets on this machine, the home as ~").optional(),
        none: z
          .enum(PROJECT_FOLDER_NONE)
          .describe("Why none: no task folder here, none holds the others, or another has it")
          .optional(),
        holder: z.string().describe("For taken: the project that has the folder").optional(),
        current: z
          .string()
          .describe(
            "The folder it has here now, when another: kept unless only the prototype changed",
          )
          .optional(),
      }),
    )
    .describe("Per project, the folder it gets or why none, in creation order"),
  owners: z
    .array(
      z.strictObject({
        name: z.string().describe("As first written"),
        me: z.boolean().describe("It is you (--me): no owner"),
        tasks: Count.describe("Tasks"),
      }),
    )
    .describe("Every distinct owner"),
  attention: z
    .array(
      z.strictObject({
        code: z.enum(codes).describe("Problem code"),
        severity: z.enum(["error", "warning"]).describe("An error blocks"),
        count: Count.describe("How often"),
      }),
    )
    .describe("Needs attention: every problem code found, errors first"),
  problems: z.array(ImportProblem).describe("Every problem, up to 2,000"),
  problems_more: Count.describe("Problems beyond those, in report.json"),
  tasks: z
    .array(
      z.strictObject({
        legacy_id: z.string().describe("The prototype's ID"),
        ref: z.string().describe("Its reference, if nothing else is created first"),
        area: z.string().describe("Area title"),
        project: z.string().describe("Project title").optional(),
        status: z.enum(["open", "waiting", "review", "backlog"]).describe("Status"),
        lifecycle: z.enum(["active", "completed"]).describe("Lifecycle"),
        wrap: z.enum(["pending", "wrapped"]).describe("Wrap-up of a completed task").optional(),
        folder: TaskFolder.describe("Its folder").optional(),
        due: z.string().describe("Due date").optional(),
        focus: z.string().describe("Starred: focus_on").optional(),
        imported: z.boolean().describe("The space already holds its legacy ID").optional(),
      }),
    )
    .describe("Per task, in creation order, up to 2,000"),
  tasks_more: Count.describe("Tasks beyond those, in report.json"),
  not_imported: z
    .array(
      z.strictObject({
        what: z
          .enum([
            "code",
            "agent_rules",
            "snapshots",
            "notes",
            "ticket_inventory",
            "audit",
            "unready_events",
            "raw_events",
            "orphans",
            "browser_actions",
          ])
          .describe("What is not imported (A7 3.15.7)"),
        count: Count.describe("How many, where counted").optional(),
      }),
    )
    .describe("Not imported, with A7 3.15.7's reasons"),
});
export type ImportPlanningPreviewResult = z.infer<typeof ImportPlanningPreviewResult>;

export const importPlanningPreview = defineEntry({
  name: "import.planning.preview",
  summary: "Dry run of the Planning prototype import: a report and a preview token.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "never",
  audience: "caller",
  ops: [],
  input: ImportPlanningPreviewInput,
  output: ImportPlanningPreviewResult,
  faces: { ui: true },
  errors: ["invalid_input", "not_found", "forbidden", "space_unavailable", "read_only"],
  examples: [
    {
      title: "Mira's prototype folder, with her name",
      actor: "user",
      input: {
        folder: "/home/mira/planning",
        me: "Mira Okafor",
      },
      output: {
        run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
        folder: "/home/mira/.tasks/spaces/mira/exchange/planning/ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
        source: { folder: "/home/mira/planning" },
        blocked: false,
        token: "pv1_AtekacJbssQkxs2yO8RxABLlpCsi-6x_RmcCKsW-RuY",
        time_zone: "Europe/Lisbon",
        options: { me: "Mira Okafor", checked_as: "completed", include_orphans: false },
        counts: {
          todo_task_lines: 39,
          done_task_lines: 10,
          task_lines: 49,
          metadata_entries: 32,
          metadata_orphans: 3,
          task_lines_without_metadata: 19,
          event_files: 17,
          ready_files: 4,
          counted_event_files: 16,
          events_not_ready: 1,
          actions_events: 0,
          actions_added: 0,
          tasks: 48,
          active: 34,
          completed: 14,
          wrapped: 8,
          aliases: 48,
          areas: 5,
          areas_existing: 1,
          projects: 4,
          projects_existing: 1,
          sources: 11,
          sources_existing: 1,
          links: 12,
          folders: 6,
          folders_missing: 1,
          project_folders: 3,
          duplicates_left_out: 1,
          orphans_included: 0,
          text_sanitised: 0,
          source_changes: 0,
        },
        reconciled: true,
        sources_by_kind: [
          { kind: "ticket", count: 2 },
          { kind: "email", count: 1 },
        ],
        statuses: [{ prototype: "open", status: "open", count: 22 }],
        project_folders: [
          { project: "Lumen portal", area: "Lumen", none: "no_common_folder" },
          { project: "Clinic sync (Q4)", area: "Lumen", folder: "~/work/lumen/clinic-sync" },
        ],
        owners: [
          { name: "Mira Okafor", me: true, tasks: 24 },
          { name: "Tomas", me: false, tasks: 1 },
        ],
        attention: [
          { code: "fallback-id", severity: "warning", count: 7 },
          { code: "ticked-in-file", severity: "warning", count: 2 },
        ],
        problems: [
          {
            code: "fallback-id",
            severity: "warning",
            file: "TODO.md",
            line: 5,
            task: "t-b3fc07df",
          },
        ],
        problems_more: 0,
        tasks: [
          {
            legacy_id: "t-eb2a8db7",
            ref: "M-16",
            area: "Lumen",
            project: "Lumen portal",
            status: "open",
            lifecycle: "active",
            folder: { path: "~/work/lumen/portal", state: "own" },
            due: "2026-11-20",
          },
        ],
        tasks_more: 0,
        not_imported: [{ what: "code" }, { what: "unready_events", count: 1 }],
      },
    },
  ],
});
