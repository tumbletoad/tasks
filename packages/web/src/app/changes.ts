// One change log per live session (`changeLogOf`), made with it, so it hears the first snapshot and
// survives a switch of view. The log itself is the page's and the phone's (@ttasks/client/today).
import { ChangeLog, type ChangeSource } from "@ttasks/client/today";

const logs = new WeakMap<ChangeSource, ChangeLog>();

/** The live session's change log, made the first time it is asked for. */
export function changeLogOf(live: ChangeSource): ChangeLog {
  let log = logs.get(live);
  if (log === undefined) {
    log = new ChangeLog(live);
    logs.set(live, log);
  }
  return log;
}
