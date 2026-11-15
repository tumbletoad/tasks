// history.redo: redo the change the user undid last (A1 3.10.1, A5 3.12). The user's only (A3
// 3.2.3). It brings back exactly what the undo set back, with the change's own provenance, and is
// all or nothing: a field another actor changed since the undo makes it a conflict. A new change
// of the user's ends what can be redone.
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { RequestId } from "../schemas.ts";
import { CommitInput, HistoryResultFields } from "./history-undo.ts";
import { requestId } from "./fixture.ts";

export const HistoryRedoInput = z.strictObject({
  commit: CommitInput.describe(
    "The change you mean: refused unless it is the next one to redo",
  ).optional(),
  request_id: RequestId,
});

export const HistoryRedoResult = z.strictObject({
  result: z.enum(["redone"]).describe("The change is back"),
  ...HistoryResultFields,
});

export const historyRedo = defineEntry({
  name: "history.redo",
  summary: "Redo the change you undid last, as long as nobody changed its fields since.",
  kind: "write",
  actors: "user",
  scope: "space:write",
  remote: "write",
  audience: "none",
  ops: ["redo"],
  input: HistoryRedoInput,
  output: HistoryRedoResult,
  faces: { ui: true, cli: { verb: "redo" } },
  errors: ["invalid_input", "not_found", "conflict", "forbidden", "request_id_conflict"],
  examples: [
    {
      title: "Check M-15 off again after the undo",
      actor: "user",
      input: { request_id: requestId(41) },
      output: {
        result: "redone",
        commit: "op_6h2k8m4p0r6t2v8x4z0b6d2f8j",
        tasks: ["M-15"],
        task_count: 1,
        as_of: "1.1048.5n0w8k3q",
      },
    },
  ],
});
