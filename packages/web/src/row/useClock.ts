// The list's clock (dates.ts): today on this browser's calendar. It moves at midnight, when every
// relative date changes, and each minute only while the list holds a timed due (a due at 10:30
// turns late at 10:31). Between those moments it keeps its identity, so no row renders for it.
//
// A timer does not see a machine that slept past midnight, or a change of time zone, until it
// fires. So the clock is read again whenever the tab is shown or the window gets focus, and moves
// if the day, the zone or (for a timed due) the minute changed meanwhile (A5 3.4).
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { browserClock, type Clock } from "./dates.ts";

const MINUTE_MS = 60_000;

export function useClock(minutes: boolean): Clock {
  const { locale } = useIntl();
  const [clock, setClock] = useState(() => browserClock(locale));
  useEffect(() => {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const wait = minutes ? MINUTE_MS - (now % MINUTE_MS) : midnight.getTime() - now;
    const timer = setTimeout(() => {
      setClock(browserClock(locale));
    }, wait + 50);
    const check = () => {
      const fresh = browserClock(locale);
      const moved =
        fresh.today !== clock.today ||
        fresh.timeZone !== clock.timeZone ||
        (minutes && Math.floor(fresh.now / MINUTE_MS) !== Math.floor(clock.now / MINUTE_MS));
      if (moved) setClock(fresh);
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [clock, minutes, locale]);
  return clock;
}
