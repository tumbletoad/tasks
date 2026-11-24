// The page's one clock (dates.ts): today on this browser's calendar. Everything on the page that
// shows or asks for something that depends on the day reads it here, so all of it moves to a new
// day at the same moment. Between those moments a day reading keeps its identity, so nothing
// renders for it; a minute reading (for a timed due: one at 10:30 turns late at 10:31) moves
// each minute.
//
// A timer does not see a machine that slept past midnight, or a change of time zone, until it
// fires, and a sleeping machine's timers may fire late. So the clock is read at every minute's
// turn while the page is open, which midnight always is, and again whenever the tab is shown or
// the window gets focus.
import { useMemo, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { localDate, type DayClock } from "@ttasks/contracts/day";
import type { Clock } from "./dates.ts";

const MINUTE_MS = 60_000;

function readNow(): DayClock {
  const now = Date.now();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { today: localDate(now, timeZone), now, timeZone };
}

/** The day as of its first reading, and the minute as of its first reading. */
let reading: { readonly day: DayClock; readonly minute: DayClock } = (() => {
  const now = readNow();
  return { day: now, minute: now };
})();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Reads the clock: true when the day or the minute moved. */
function read(): boolean {
  const fresh = readNow();
  const dayMoved = fresh.today !== reading.day.today || fresh.timeZone !== reading.day.timeZone;
  const minuteMoved =
    dayMoved || Math.floor(fresh.now / MINUTE_MS) !== Math.floor(reading.minute.now / MINUTE_MS);
  if (!minuteMoved) return false;
  reading = { day: dayMoved ? fresh : reading.day, minute: fresh };
  return true;
}

function check(): void {
  if (read()) for (const listener of listeners) listener();
}

function tick(): void {
  check();
  timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS) + 50);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("focus", check);
    window.removeEventListener("pageshow", check);
  };
}

// While nothing listens no timer runs: the first reader after that reads the clock first.
const daySnapshot = (): DayClock => {
  if (listeners.size === 0) read();
  return reading.day;
};
const minuteSnapshot = (): DayClock => {
  if (listeners.size === 0) read();
  return reading.minute;
};

/** The page's clock in its locale: the day's, or with `minutes` the minute's. */
export function useClock(minutes: boolean): Clock {
  const { locale } = useIntl();
  const now = useSyncExternalStore(subscribe, minutes ? minuteSnapshot : daySnapshot);
  return useMemo(() => ({ ...now, locale }), [now, locale]);
}
