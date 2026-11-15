// run.report: a routine or run's coverage report, written to A4's run record (A3 3.4.12). Listed on
// every connection like every tool (A3 3.3), but a call works only on a connection bound to a run
// or routine: anywhere else it is `not_permitted` and writes nothing. Run and routine bindings
// arrive with M6 (M6.06), so in this build every call is refused before it reads anything.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { safeLine, safeText } from "../safe-text.ts";
import { AsOf, idPattern, Replayed, RequestId } from "../schemas.ts";
import { AS_OF_NEXT, requestId } from "./fixture.ts";

export const RunReportInput = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        name: safeLine(120).describe("The source, as the routine names it"),
        state: z.enum(["ok", "partial", "unreachable"]).describe("How far you could read it"),
        items_seen: z.int().min(0).max(1_000_000).describe("Items you read there"),
        note: safeLine(200).describe("What went wrong, in one line").optional(),
      }),
    )
    .max(20)
    .describe("One row per source the routine names")
    .optional(),
  summary: safeText(1000)
    .describe("Counts created, updated, unchanged; what was unsure")
    .optional(),
  request_id: RequestId,
});

export const RunReportResult = z.strictObject({
  result: z.literal("reported").describe("The run record holds the report"),
  run: z.string().regex(idPattern("ru")).describe("The run"),
  sources: z.int().min(0).max(20).describe("Source rows recorded"),
  as_of: AsOf,
  replayed: Replayed.optional(),
});

export const runReport = defineEntry({
  name: "run.report",
  summary: "Report a run's coverage, one row per source: works only in a run or routine.",
  kind: "write",
  actors: "run",
  scope: "space:write",
  remote: "never",
  audience: "none",
  ops: ["run.report"],
  input: RunReportInput,
  output: RunReportResult,
  faces: {
    cli: { verb: "run-report" },
    mcp: {
      tool: "run_report",
      title: "Report a routine's coverage",
      description:
        "Use only inside a routine or run, just before you end: one row per source (ok, partial or unreachable, and the items you read) and a short summary. Anywhere else it returns not_permitted.",
    },
  },
  budget: { typical: 30, max: 120 },
  errors: ["not_permitted", "invalid_input", "request_id_conflict"],
  examples: [
    {
      title: "A refresh that could not reach the issue tracker",
      input: {
        sources: [
          { name: "Mail", state: "ok", items_seen: 14 },
          {
            name: "Issue tracker",
            state: "unreachable",
            items_seen: 0,
            note: "The connector timed out.",
          },
        ],
        summary: "Created 2, updated 3, unchanged 9. Unsure whether LUM-230 is a new request.",
        request_id: requestId(17),
      },
      output: {
        result: "reported",
        run: "ru_8kq2m6t0w4z8c2f6j0n4r8v2z6",
        sources: 2,
        as_of: AS_OF_NEXT,
      },
    },
  ],
});
