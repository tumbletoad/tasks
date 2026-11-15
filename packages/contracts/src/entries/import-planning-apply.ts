// import.planning.apply and import.planning.undo (A7 3.15.5, 3.15.6): the apply of a dry run of
// the Planning prototype import, and its undo. The user's only (A3 3.2.3, `import.planning.*`):
// the CLI's `tasks import planning --apply <run> --token <token>` and `--undo <run>`, and with
// M5.12 the import card. Only the user applies an import, never an agent.
//
// The apply checks the prototype folder again, makes the plan again from the run's copy, and
// recomputes the preview token from the space as it is: any difference stops it, and the person
// runs the dry run again. It takes a verified backup first, then writes everything in one commit,
// or nothing. Over a space that holds an earlier import it is a re-import: it changes exactly the
// fields the prototype changed, never one the person changed, and shows each field both changed.
// The writer's request ID comes from the run and the token, so applying twice applies once.
//
// The undo reverts that commit: what the import made goes, what it changed is set back, and every
// task someone changed since stays as it is and is listed.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { AsOf, Replayed, RequestId, TaskRef } from "../schemas.ts";
import { requestId } from "./fixture.ts";
import { CommitId } from "./history-undo.ts";
import { IMPORT_RUN, PREVIEW_ROWS, PREVIEW_TOKEN } from "./import-planning-preview.ts";

const Count = z.int().min(0).max(1_000_000_000);
const LegacyId = z.string().max(1024).regex(/^[a-z0-9_-]+$/u);

/** The fields a re-import compares, and `sources` for the links it adds (A7 3.15.6). */
export const IMPORT_FIELDS = [
  "title",
  "summary",
  "context",
  "status",
  "priority",
  "owner",
  "waiting_on",
  "source_at",
  "reviewed_at",
  "due",
  "focus",
  "grouping",
  "lifecycle",
  "wrap",
  "ext.planning",
  "place",
  "evidence",
  "sources",
] as const;
const Field = z.enum(IMPORT_FIELDS);

export const ImportPlanningApplyInput = z.strictObject({
  run: z.string().regex(IMPORT_RUN).describe("The dry run's run ID"),
  token: z.string().regex(PREVIEW_TOKEN).describe("The dry run's preview token"),
  request_id: RequestId,
});

export const ImportPlanningApplyResult = z.strictObject({
  run: z.string().regex(IMPORT_RUN).describe("The run applied: --undo names it"),
  status: z
    .enum(["applied", "unchanged"])
    .describe("applied: one commit; unchanged: the space holds the prototype as it is already"),
  commit: CommitId.describe("The import's commit").optional(),
  backup: z.string().max(120).describe("The verified backup taken just before it").optional(),
  counts: z
    .strictObject({
      created: Count.describe("Tasks created"),
      updated: Count.describe("Tasks it changed"),
      unchanged: Count.describe("Tasks it left as they are"),
      deleted: Count.describe("Tasks a person deleted since: not brought back"),
      conflicts: Count.describe("Tasks with fields both the prototype and the space changed"),
      gone: Count.describe("Legacy IDs no longer in the prototype: nothing is deleted"),
    })
    .describe("What it did"),
  tasks: z
    .array(
      z.strictObject({
        legacy_id: LegacyId.describe("The prototype's ID"),
        ref: TaskRef.describe("Its task").optional(),
        outcome: z.enum(["created", "updated", "unchanged", "deleted"]).describe("What happened"),
        changed: z.array(Field).describe("Fields it changed").optional(),
        conflicts: z
          .array(Field)
          .describe("Fields both sides changed: kept as the space has them")
          .optional(),
      }),
    )
    .describe("Each task created, changed, deleted or in conflict, up to 2,000"),
  tasks_more: Count.describe("Tasks beyond those, in the run's apply.json"),
  gone: z.array(LegacyId).max(PREVIEW_ROWS).describe("Legacy IDs gone from the prototype"),
  as_of: AsOf.optional(),
  replayed: Replayed.optional(),
});
export type ImportPlanningApplyResult = z.infer<typeof ImportPlanningApplyResult>;

export const ImportPlanningUndoInput = z.strictObject({
  run: z.string().regex(IMPORT_RUN).describe("The applied run to undo"),
  request_id: RequestId,
});

export const ImportPlanningUndoResult = z.strictObject({
  run: z.string().regex(IMPORT_RUN).describe("The run undone"),
  commit: CommitId.describe("The undo's commit"),
  undone: CommitId.describe("The import's commit it reverted"),
  removed: Count.describe("Tasks the import made that are gone again"),
  restored: Count.describe("Tasks the import changed that are set back"),
  kept: z
    .array(
      z.strictObject({
        task: TaskRef.describe("A task someone changed since: it stays as it is"),
        fields: z.array(z.string().max(40)).describe("What was changed since"),
      }),
    )
    .describe("Tasks that stay as they are, up to 2,000"),
  kept_more: Count.describe("Tasks beyond those"),
  as_of: AsOf,
  replayed: Replayed.optional(),
});
export type ImportPlanningUndoResult = z.infer<typeof ImportPlanningUndoResult>;

/** Every operation an import's apply may write (A7 3.15.5). */
const APPLY_OPS = [
  "task.create",
  "task.patch",
  "task.move",
  "task.complete",
  "task.reopen",
  "task.wrap_up",
  "log.add",
  "source.add",
  "place.set",
  "alias.add",
  "area.upsert",
  "project.upsert",
  "exchange.create",
];

export const importPlanningApply = defineEntry({
  name: "import.planning.apply",
  summary: "Apply a dry run of the Planning prototype import, behind a verified backup.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "never",
  audience: "none",
  ops: APPLY_OPS,
  input: ImportPlanningApplyInput,
  output: ImportPlanningApplyResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "space_unavailable",
    "read_only",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "Apply Mira's dry run",
      actor: "user",
      input: {
        run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
        token: "pv1_AtekacJbssQkxs2yO8RxABLlpCsi-6x_RmcCKsW-RuY",
        request_id: requestId(51),
      },
      output: {
        run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
        status: "applied",
        commit: "op_6h2k8m4p0r6t2v8x4z0b6d2f8j",
        backup: "pre-import-20261114T090000.000Z-e1-s1046",
        counts: { created: 48, updated: 0, unchanged: 0, deleted: 0, conflicts: 0, gone: 0 },
        tasks: [{ legacy_id: "t-eb2a8db7", ref: "M-16", outcome: "created" }],
        tasks_more: 47,
        gone: [],
      },
    },
  ],
});

export const importPlanningUndo = defineEntry({
  name: "import.planning.undo",
  summary: "Undo an applied import; tasks changed since stay as they are and are listed.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "never",
  audience: "none",
  ops: ["import.undo"],
  input: ImportPlanningUndoInput,
  output: ImportPlanningUndoResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "space_unavailable",
    "read_only",
    "request_id_conflict",
  ],
  examples: [
    {
      title: "Undo Mira's import",
      actor: "user",
      input: { run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t", request_id: requestId(52) },
      output: {
        run: "ex_0c4g8k2n6r0v4y8b2e6h0m4q8t",
        commit: "op_7j3m9n5q1s7v3x9z5b1d7f3h9k",
        undone: "op_6h2k8m4p0r6t2v8x4z0b6d2f8j",
        removed: 47,
        restored: 0,
        kept: [{ task: "M-16", fields: ["title"] }],
        kept_more: 0,
        as_of: "1.1049.5n0w8k3q",
      },
    },
  ],
});
