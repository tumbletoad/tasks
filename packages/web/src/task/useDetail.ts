// The expanded task's detail, live (A5 3.15 item 8): read when the task expands, and again
// whenever a frame of the feed touched the task (its row, a note, a log entry, a source) or a
// fresh snapshot replaced the working set. A card that shows a source whose key another task may
// hold reads again on a frame that touched any task, since where captures go is decided there.
// Only the newest read applies: an older one that answers late never replaces a newer detail. A read that
// fails keeps what is shown and says so, unless the session itself failed (signed out, a stale
// build), which the frame reports.
import { useContext, useEffect, useState } from "react";
import { Session } from "../context.ts";
import { Latest } from "../latest.ts";
import { readDetail, type Detail } from "./detail.ts";

export interface DetailState {
  readonly detail: Detail | undefined;
  /** Where the feed was when `detail` was asked for: a write of what it shows goes with this base. */
  readonly base?: string | undefined;
  /** The last read failed; `detail` is the one before it, if any. */
  readonly failed: boolean;
  /** The task is not in the space (purged, or never was). */
  readonly missing: boolean;
}

/** Whether the detail says, or could say, where captures of a source go: other tasks decide it. */
const holdersShown = (detail: Detail | undefined): boolean =>
  detail?.sources.some(
    (s) => s.captures_to !== undefined || (s.removed !== undefined && s.key !== undefined),
  ) === true;

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";

/** `requests`: the notes the sessions the thread shows name as their requests, read whatever their age. */
export function useDetail(task: string, requests: readonly string[] = []): DetailState {
  const { api, live } = useContext(Session);
  const [state, setState] = useState<DetailState>({
    detail: undefined,
    failed: false,
    missing: false,
  });

  // One string, so receipts read again with the same requests read nothing again.
  const named = requests.join(" ");
  useEffect(() => {
    let current = true;
    const wanted = named === "" ? [] : named.split(" ");
    const reads = new Latest();
    let shown: Detail | undefined;
    const load = () => {
      const newest = reads.begin(task);
      const base = live.store.asOf;
      readDetail(api.client, task, wanted)
        .then((detail) => {
          if (!current || !newest()) return;
          shown = detail;
          setState({ detail, base, failed: false, missing: false });
        })
        .catch((error: unknown) => {
          if (!current || !newest() || live.failed(error)) return;
          setState((known) => ({ ...known, failed: true, missing: isNotFound(error) }));
        });
    };
    load();
    const stop = live.onTouched((touched) => {
      // A fresh snapshot reads again whatever the task: one the working set does not hold (a
      // completed task) is in no snapshot's list, and what changed before it is unknown.
      if (touched.reset || touched.tasks.has(task)) load();
      else if (touched.tasks.size > 0 && holdersShown(shown)) load();
    });
    return () => {
      current = false;
      stop();
    };
  }, [api, live, task, named]);

  return state;
}
