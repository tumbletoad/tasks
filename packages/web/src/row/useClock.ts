// The list's clock (dates.ts): today on this browser's calendar. It moves at midnight, when every
// relative date changes, and each minute only while the list holds a timed due (a due at 10:30
// turns late at 10:31). Between those moments it keeps its identity, so no row renders for it.
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { browserClock, type Clock } from "./dates.ts";

export function useClock(minutes: boolean): Clock {
  const { locale } = useIntl();
  const [clock, setClock] = useState(() => browserClock(locale));
  useEffect(() => {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const wait = minutes ? 60_000 - (now % 60_000) : midnight.getTime() - now;
    const timer = setTimeout(() => {
      setClock(browserClock(locale));
    }, wait + 50);
    return () => {
      clearTimeout(timer);
    };
  }, [clock, minutes, locale]);
  return clock;
}
