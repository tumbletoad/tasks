// The library's answers as the page reads them, named once from the generated client.
import type { Client } from "@ttasks/contracts/generated/client.ts";

type Answer<F extends (input: never) => Promise<unknown>> = Awaited<ReturnType<F>>;

export type PageRead = Answer<Client["page"]["read"]>;
export type PageView = Extract<PageRead, { view: "page" }>;
export type NodeView = Extract<PageRead, { view: "node" }>;
export type PageHistory = Answer<Client["page"]["history"]>;
export type Version = Extract<PageHistory, { view: "versions" }>["versions"][number];
export type TrashedPages = Answer<Client["page"]["trashed"]>;
export type TrashedPage = TrashedPages["rows"][number];
