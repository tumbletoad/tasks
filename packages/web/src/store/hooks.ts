// React on top of the live store, through `useSyncExternalStore`. The store itself has no React.
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Session } from "../context.ts";
import {
  PagedQuery,
  type PageSource,
  type QueryDef,
  type QueryOptions,
  type QueryState,
} from "./queries.ts";
import type { LiveState } from "./store.ts";

/** The tab's live state: open rows, the tree, instances and the feed's phase. */
export function useLive(): LiveState {
  const { live } = useContext(Session);
  return useSyncExternalStore(live.subscribe, live.getState);
}

/**
 * A paged query (Completed, Trash, search) that the feed invalidates by query (queries.ts). It is
 * read when the component mounts and dropped when it unmounts. `source` is read once: a new query
 * is a new component key.
 */
export function usePagedQuery<R extends { readonly id: string }>(
  def: QueryDef,
  source: PageSource<R>,
  options?: QueryOptions,
): { readonly state: QueryState<R>; readonly query: PagedQuery<R> } {
  const { live } = useContext(Session);
  const [query] = useState(() => new PagedQuery(def, source, options));
  useEffect(() => {
    const stop = live.onChanges((changes) => {
      query.apply(changes);
    });
    void query.refresh();
    return stop;
  }, [live, query]);
  const state = useSyncExternalStore(query.subscribe, query.getState);
  return { state, query };
}
