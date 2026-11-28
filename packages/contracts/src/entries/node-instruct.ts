// node.instruct: the person's text for agents on the space, an area or a project, whole: the one
// standing instruction for every task below it. Only a person writes it, and the writer refuses
// it from anyone else: a page or a mail an agent read never becomes an order to later agents.
// An empty text takes it away; the words before stay in the history.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { PAGE_LIMITS } from "../pages.ts";
import { safeText } from "../safe-text.ts";
import { Base, Replayed, RequestId, WriteAsOf } from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";
import { LUMEN } from "./page-read.ts";

export const NodeInstructInput = z.strictObject({
  target: z.string().max(250).describe('A project or area by path or ID, or "space"'),
  text: safeText(PAGE_LIMITS.user.body).describe("The instruction, whole; empty takes it away"),
  base: Base,
  request_id: RequestId,
});

export const NodeInstructResult = z.strictObject({
  result: z.enum(["set", "no_change"]).describe("set, or the text was this already"),
  target: z.string().max(40).describe("The node's ID"),
  as_of: WriteAsOf,
  replayed: Replayed.optional(),
});

export const nodeInstruct = defineEntry({
  name: "node.instruct",
  summary: "Set the user's text for agents on the space, an area or a project.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "none",
  ops: ["node.instruct"],
  input: NodeInstructInput,
  output: NodeInstructResult,
  faces: { ui: true },
  errors: [
    "invalid_input",
    "not_found",
    "conflict",
    "forbidden",
    "too_large",
    "request_id_conflict",
    "applied_earlier",
  ],
  examples: [
    {
      title: "Tell every agent working in Lumen Health how to handle mail",
      actor: "user",
      input: {
        target: LUMEN.project,
        text: "Never mail the clinic directly: drafts come to me.",
        base: AS_OF,
        request_id: requestId(96),
      },
      output: { result: "set", target: LUMEN.project, as_of: AS_OF_NEXT },
    },
  ],
});
