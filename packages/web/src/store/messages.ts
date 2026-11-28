// The feed's messages as the page reads them: the store's (@ttasks/client/store), and the two only
// the page takes, this machine's settings and the Agent Monitor's view.
import { jsonOf, messageOf, type FeedMessage } from "@ttasks/client/store";
import { parseAgents, type AgentsView } from "./agents.ts";

/** A setting of this machine as the feed carries it: its key and value, or its default. */
export interface MachinePreference {
  readonly key: string;
  readonly value: unknown;
  /** `default`: nobody chose it. */
  readonly state: string;
}

/** This machine's settings of the page, after `hello` and again on each change. */
export interface MachineMessage {
  readonly type: "machine";
  readonly preferences: readonly MachinePreference[];
}

/** The Agent Monitor's view for an Agents page (store/agents.ts). */
export interface AgentsMessage {
  readonly type: "agents";
  readonly view: AgentsView;
}

export type PageMessage = FeedMessage | MachineMessage | AgentsMessage;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A message from the feed, checked by its shape, or undefined when it is none the page takes. */
export function parsePageMessage(text: unknown): PageMessage | { type: "unreadable" } | undefined {
  const value = jsonOf(text);
  if (!isRecord(value)) return undefined;
  switch (value["type"]) {
    case "agents": {
      const view = parseAgents(value);
      return view === undefined ? undefined : { type: "agents", view };
    }
    case "machine": {
      const list = value["preferences"];
      if (!Array.isArray(list)) return undefined;
      const preferences = list.flatMap((item: unknown) =>
        isRecord(item) && typeof item["key"] === "string"
          ? [
              {
                key: item["key"],
                value: item["value"],
                state: typeof item["state"] === "string" ? item["state"] : "",
              },
            ]
          : [],
      );
      return { type: "machine", preferences };
    }
    default:
      return messageOf(value);
  }
}
