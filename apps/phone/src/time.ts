// How long ago something was, in the app's words.
import { WORDS } from "./words.ts";

export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return WORDS.justNow;
  if (minutes < 60) return WORDS.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? WORDS.hours(hours) : WORDS.days(Math.floor(hours / 24));
}
