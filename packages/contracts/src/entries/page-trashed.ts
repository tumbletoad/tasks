// page.trashed: the pages someone moved to the Trash, newest first, a page of them at a time, each
// with the change that moved it. A page whose task or project is in the Trash is not listed: it
// went with what holds it and comes back with it.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { CompactPage } from "../pages.ts";
import { safeLine } from "../safe-text.ts";
import { TRASH_CURSOR, TrashChange } from "./task-trash.ts";
import { LUMEN, M180 } from "./page-read.ts";

export const PageTrashedInput = z.strictObject({
  q: safeLine(200).describe("Words of a title, or a reference such as M-180").optional(),
  limit: z.int().min(1).max(200).describe("Rows per page; default 50").optional(),
  cursor: z.string().max(60).describe("Next page: the last page's cursor").optional(),
});

export const TrashedPage = CompactPage.extend({
  on: z.string().describe("What held it, by name, a deleted one too"),
  removed: TrashChange.describe("The change that moved it to the Trash"),
});

export const PageTrashedResult = z.strictObject({
  rows: z.array(TrashedPage).describe("Newest change first"),
  cursor: z.string().regex(TRASH_CURSOR).describe("Pass it for the next page").optional(),
});

export const pageTrashed = defineEntry({
  name: "page.trashed",
  summary: "The pages in the Trash, newest change first, a page at a time.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: PageTrashedInput,
  output: PageTrashedResult,
  defaults: [["limit", 50]],
  faces: { ui: true },
  errors: ["invalid_input", "space_unavailable", "forbidden"],
  examples: [
    {
      title: "The pages in the Trash",
      actor: "user",
      input: {},
      output: {
        rows: [
          {
            ...M180,
            title: "Time zone rules",
            brief: "Store UTC plus the clinic's zone ID; convert once",
            owner_id: LUMEN.project,
            under: LUMEN.project,
            version: 1050,
            by: "agent:codex-work",
            at: 1_778_590_000_000,
            why: "merged into M-140, the report template",
            deleted_at: 1_778_590_000_000,
            on: "Lumen Health",
            removed: {
              id: "op_6n0r4v8z2d6h0m4q8t2x6b0f4j",
              at: "2026-11-12T12:46:40.000Z",
              by: "agent:codex-work",
              reason: "merged into M-140, the report template",
              count: 1,
            },
          },
        ],
      },
    },
  ],
});
