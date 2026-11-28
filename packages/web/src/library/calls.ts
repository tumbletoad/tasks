// The library's calls, shaped as the generated client will hold them once their entries join the
// registry (`client.page.read`, `client.node.instruct`): the screens call `api.library.page.read`,
// and that line becomes `api.client.page.read` then. Types only from contracts: no Zod in the page.
import type {
  NodeInstructInput,
  NodeInstructResult,
  PageHistoryInput,
  PageHistoryResult,
  PageReadInput,
  PageReadResult,
  PageTrashedInput,
  PageTrashedResult,
  PageWriteInput,
  PageWriteResult,
} from "@ttasks/contracts";

interface Schema {
  readonly _zod: { readonly input: unknown; readonly output: unknown };
}
type In<S extends Schema> = S["_zod"]["input"];
type Out<S extends Schema> = S["_zod"]["output"];

export type PageRead = Out<typeof PageReadResult>;
export type PageView = Extract<PageRead, { view: "page" }>;
export type NodeView = Extract<PageRead, { view: "node" }>;
export type PageHistory = Out<typeof PageHistoryResult>;
export type Version = Extract<PageHistory, { view: "versions" }>["versions"][number];
export type TrashedPages = Out<typeof PageTrashedResult>;
export type TrashedPage = TrashedPages["rows"][number];
export type PageWritten = Out<typeof PageWriteResult>;
export type InstructWritten = Out<typeof NodeInstructResult>;

/** Posts one entry's input and resolves with its result, or rejects with the service's refusal. */
export function libraryCalls(send: (name: string, input: unknown) => Promise<unknown>) {
  const call = send as (name: string, input: unknown) => Promise<never>;
  return {
    page: {
      read: (input: In<typeof PageReadInput>): Promise<PageRead> => call("page.read", input),
      write: (input: In<typeof PageWriteInput>): Promise<PageWritten> => call("page.write", input),
      history: (input: In<typeof PageHistoryInput>): Promise<PageHistory> =>
        call("page.history", input),
      trashed: (input: In<typeof PageTrashedInput>): Promise<TrashedPages> =>
        call("page.trashed", input),
    },
    node: {
      instruct: (input: In<typeof NodeInstructInput>): Promise<InstructWritten> =>
        call("node.instruct", input),
    },
  };
}

export type LibraryCalls = ReturnType<typeof libraryCalls>;
