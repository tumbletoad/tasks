// The groups a capture can name: new work goes to live areas and projects only. The archived ones
// take no new task, but their names still mean them, so they never fall through to another group of
// the same name.
import type { NodeRow } from "../store/rows.ts";
import { topLevel, type Nodes } from "../store/tree.ts";
import { liveGroups } from "../today/groups.ts";
import type { CaptureContext } from "./parse.ts";

export function captureGroups(nodes: Nodes): {
  readonly areas: NodeRow[];
  readonly projects: NodeRow[];
  readonly archived: NonNullable<CaptureContext["archived"]> & {
    readonly areas: NodeRow[];
    readonly projects: NodeRow[];
  };
} {
  const open = liveGroups(nodes);
  const liveIds = new Set([...open.areas, ...open.projects].map((g) => g.id));
  const tops = topLevel(nodes);
  const shelved = [...nodes.values()].filter((n) => n.kind === "project" && !liveIds.has(n.id));
  return {
    ...open,
    archived: {
      areas: shelved.filter((n) => tops.includes(n)),
      projects: shelved.filter((n) => !tops.includes(n)),
    },
  };
}
