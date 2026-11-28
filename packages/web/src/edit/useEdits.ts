// The live session's edits (edits.ts) for React: one controller per live session, kept beside it
// like Today's change log, so every view of the tab and the toast share it.
import { useContext, useSyncExternalStore } from "react";
import { requestId, type Api } from "../api.ts";
import { Session } from "../context.ts";
import type { Live } from "../live.ts";
import { levelsKey } from "./change.ts";
import { Edits, type EditState } from "./edits.ts";
import { actionKeeper, unsavedKeeper } from "../unsent.ts";

const controllers = new WeakMap<Live, Edits>();

/** The live session's edits, made the first time they are asked for. */
export function editsOf(live: Live, api: Api): Edits {
  let edits = controllers.get(live);
  if (edits === undefined) {
    edits = new Edits({
      client: api.client,
      write: (send, overlay, request) => live.write(send, overlay, request),
      asOf: () => live.store.asOf,
      levels: () => levelsKey(live.getState().scales.efforts),
      failed: (error) => live.failed(error),
      onChanges: (listener) => live.onChanges(listener),
      rowOf: (ref) => {
        for (const task of live.getState().tasks.values()) if (task.ref === ref) return task;
        return undefined;
      },
      space: () => live.getState().space?.id,
      newRequest: requestId,
      alive: () => !live.stopped,
      ...(live.spaceId === undefined
        ? {}
        : { keeper: unsavedKeeper(live.spaceId), actions: actionKeeper(live.spaceId) }),
    });
    controllers.set(live, edits);
  }
  return edits;
}

export function useEdits(): Edits {
  const { api, live } = useContext(Session);
  return editsOf(live, api);
}

/** The edits' state: what waits unsaved, and the rows in their hold. */
export function useEditState(): EditState {
  const edits = useEdits();
  return useSyncExternalStore(edits.subscribe, edits.getState);
}
