// The expanded task's detail, live: read when the task expands, and again
// whenever a frame of the feed touched the task (its row, a note, a log entry, a source) or a
// fresh snapshot replaced the working set. A card that shows a source whose key another task may
// hold reads again on a frame that touched any task, since where captures go is decided there.
// Only the newest read applies: an older one that answers late never replaces a newer detail, and
// stops reading pages once it is not the newest. A read that fails keeps what is shown and says
// so, unless the session itself failed (signed out, a stale build), which the frame reports.
//
// "Older entries" reads the entries before the oldest shown, from where the last read ended; every
// read the feed asks for from then on reads to that depth. A failed one leaves the button to press
// again. What is loaded lives as long as the task stays expanded.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Session } from "../context.ts";
import { Latest } from "../latest.ts";
import { PAGES, readDetail, readOlder, type Detail, type ThreadRead } from "./detail.ts";

export interface DetailState {
  readonly detail: Detail | undefined;
  /** Where the feed was when `detail` was asked for: a write of what it shows goes with this base. */
  readonly base?: string | undefined;
  /** The last read failed; `detail` is the one before it, if any. */
  readonly failed: boolean;
  /** The task is not in the space (purged, or never was). */
  readonly missing: boolean;
  /** Reads the entries before the oldest `detail` holds, when there are any. */
  readonly older?: (() => void) | undefined;
  /** Older entries were asked for and have not come yet. */
  readonly loadingOlder?: boolean;
  /** The last read of older entries failed: pressing again tries again. */
  readonly olderFailed?: boolean;
}

interface Read {
  readonly read: ThreadRead | undefined;
  readonly base?: string | undefined;
  readonly failed: boolean;
  readonly missing: boolean;
  readonly loadingOlder: boolean;
  readonly olderFailed: boolean;
}

const NONE: Read = {
  read: undefined,
  failed: false,
  missing: false,
  loadingOlder: false,
  olderFailed: false,
};

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
  const [state, setState] = useState<Read>(NONE);
  /** Reads the entries before the oldest shown: set by the effect that reads the task. */
  const more = useRef<() => void>(() => undefined);
  /** How many pages the person asked to see of the task: a task expanded anew starts over. */
  const depth = useRef({ task, pages: PAGES });
  if (depth.current.task !== task) depth.current = { task, pages: PAGES };

  // One string, so receipts read again with the same requests read nothing again.
  const named = requests.join(" ");
  useEffect(() => {
    let current = true;
    const wanted = named === "" ? [] : named.split(" ");
    const reads = new Latest();
    /** The newest read that applied. */
    let held: ThreadRead | undefined;
    /** A read from the top is on its way: what it brings is newer than `held`. */
    let reading = false;
    const load = () => {
      const newest = reads.begin(task);
      const base = live.store.asOf;
      reading = true;
      readDetail(api.client, task, wanted, depth.current.pages, () => !current || !newest())
        .then((read) => {
          if (!current || !newest()) return;
          reading = false;
          held = read;
          setState({ ...NONE, read, base });
        })
        .catch((error: unknown) => {
          if (!current || !newest()) return;
          reading = false;
          if (live.failed(error)) return;
          setState((known) => ({
            ...known,
            failed: true,
            missing: isNotFound(error),
            loadingOlder: false,
            olderFailed: known.loadingOlder,
          }));
        });
    };
    more.current = () => {
      const from = held;
      if (from?.before === undefined) return;
      // A read the feed asks for meanwhile goes as deep, so the press is not lost to it.
      depth.current = { task, pages: from.pages.length + PAGES };
      setState((known) => ({ ...known, loadingOlder: true, olderFailed: false }));
      // One on its way from the top would be lost to a read that goes on from `held`: it goes as
      // deep instead.
      if (reading) {
        load();
        return;
      }
      const newest = reads.begin(task);
      readOlder(api.client, task, from, () => !current || !newest())
        .then((read) => {
          if (!current || !newest()) return;
          held = read;
          setState((known) => ({ ...known, read, loadingOlder: false }));
        })
        .catch((error: unknown) => {
          if (!current || !newest()) return;
          depth.current = { task, pages: from.pages.length };
          setState((known) => ({
            ...known,
            loadingOlder: false,
            olderFailed: !live.failed(error),
          }));
        });
    };
    load();
    const stop = live.onTouched((touched) => {
      // A fresh snapshot reads again whatever the task: one the working set does not hold (a
      // completed task) is in no snapshot's list, and what changed before it is unknown.
      if (touched.reset || touched.tasks.has(task)) load();
      else if (touched.tasks.size > 0 && holdersShown(held?.detail)) load();
    });
    return () => {
      current = false;
      more.current = () => undefined;
      stop();
    };
  }, [api, live, task, named]);

  const older = useCallback(() => {
    // One press at a time: a press while the last one reads asks for nothing more.
    if (!state.loadingOlder) more.current();
  }, [state.loadingOlder]);

  const detail = state.read?.detail;
  return {
    detail,
    base: state.base,
    failed: state.failed,
    missing: state.missing,
    ...(detail?.partial === true ? { older } : {}),
    loadingOlder: state.loadingOlder,
    olderFailed: state.olderFailed,
  };
}
