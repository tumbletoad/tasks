// page.history: the earlier versions of a page's body, or of a node's description, for the person.
// The list holds who, when and why, never the words, a page at a time; one version's words are
// read by its seq, for Show. Versions come from the change log: there is no table of them.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { PAGE_LIST, PageVersion } from "../pages.ts";
import { AsOf } from "../schemas.ts";
import { AS_OF } from "./fixture.ts";
import { M180, TIME_ZONES } from "./page-read.ts";

const FIRST_NOTES = "# Time zone rules\n\nStore every appointment in UTC. Convert when shown.";

/** Where the next page of versions starts: the last version's seq. */
export const HISTORY_CURSOR = /^[1-9][0-9]{0,15}$/u;

export const PageHistoryInput = z.strictObject({
  target: z.string().max(250).describe("The page (M-180), or a project, area or the space"),
  seq: z
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("This version's words, for Show")
    .optional(),
  limit: z
    .int()
    .min(1)
    .max(PAGE_LIST * 2)
    .describe("Versions per page; default 25")
    .optional(),
  cursor: z.string().max(20).describe("Next page: the last page's cursor").optional(),
});

export const PageHistoryResult = z.union([
  z.strictObject({
    view: z.literal("versions").describe("Newest first"),
    as_of: AsOf,
    versions: z
      .array(PageVersion)
      .max(PAGE_LIST * 2)
      .describe("Who, when and why, newest first"),
    cursor: z.string().regex(HISTORY_CURSOR).describe("Pass it for older versions").optional(),
  }),
  z.strictObject({
    view: z.literal("version").describe("One version's words"),
    as_of: AsOf,
    version: PageVersion.describe("The version"),
    text: z.string().describe("The body, or the description, as this version left it"),
  }),
]);

export const pageHistory = defineEntry({
  name: "page.history",
  summary: "List the earlier versions of a page or a description, or read one of them.",
  kind: "read",
  actors: "user",
  scope: "space:read",
  remote: "read",
  audience: "caller",
  ops: [],
  input: PageHistoryInput,
  output: PageHistoryResult,
  defaults: [["limit", PAGE_LIST]],
  faces: { ui: true },
  errors: ["invalid_input", "not_found", "space_unavailable", "forbidden"],
  examples: [
    {
      title: "The versions of M-180, newest first",
      actor: "user",
      input: { target: M180.ref, limit: 2 },
      output: {
        view: "versions",
        as_of: AS_OF,
        versions: [
          {
            seq: 1031,
            at: "2026-11-10T15:02:00Z",
            by: "agent:codex-work",
            why: "store the zone ID, not the offset: M-3's reports drifted",
            chars: TIME_ZONES.length,
          },
          { seq: 1024, at: "2026-11-09T11:40:00Z", by: "user", restored_from: 1012, chars: 212 },
        ],
        cursor: "1024",
      },
    },
    {
      title: "Show the version change 1012 made",
      actor: "user",
      input: { target: M180.ref, seq: 1012 },
      output: {
        view: "version",
        as_of: AS_OF,
        version: {
          seq: 1012,
          at: "2026-11-02T10:00:00Z",
          by: "agent:claude-code",
          why: "first notes from M-14",
          chars: FIRST_NOTES.length,
        },
        text: FIRST_NOTES,
      },
    },
  ],
});
