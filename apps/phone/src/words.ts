// Every word the phone app shows, in one place: short and plain, the same where the page says the
// same thing.
import { PRODUCT_NAME } from "@ttasks/brand";
import type { TodaySection } from "@ttasks/client/today";

export const WORDS = {
  notPaired: "Not paired with a computer.",
  removed: "This phone was removed on the computer.",
  howToPair: "Open Settings > Phones on your computer and scan its code.",
  scan: "Scan the code",
  scanNew: "Scan a new code",
  cancel: "Cancel",

  camera: `${PRODUCT_NAME} needs the camera to scan the code.`,
  allowCamera: "Allow the camera",
  openSettings: "Open Settings",
  notACode: `This is not a ${PRODUCT_NAME} pairing code.`,

  pairWith: (space: string) => (space === "" ? "Pair with this space" : `Pair with ${space}`),
  phoneName: "This phone's name",
  pair: "Pair",
  pairing: "Pairing…",
  codeGone: "This code no longer works. Show a new one in Settings > Phones and scan it.",
  codeOtherKey: "The computer at this code's address has another key. Scan a new code.",
  // An expired or used code is refused without a word, so it reads like no answer.
  couldNotPair: "Couldn't pair. Check the network or scan a fresh code from Settings > Phones.",

  connecting: "Connecting…",
  connected: "Connected",
  away: "Can't reach the computer.",
  otherKey: "The computer at its address has another key. Scan a new code if it was set up again.",
  tryNow: "Try now",
  updated: (ago: string) => `Shown as of ${ago}.`,
  justNow: "just now",
  minutes: (n: number) => (n === 1 ? "1 minute ago" : `${String(n)} minutes ago`),
  hours: (n: number) => (n === 1 ? "1 hour ago" : `${String(n)} hours ago`),
  days: (n: number) => (n === 1 ? "1 day ago" : `${String(n)} days ago`),
  waiting: (n: number) =>
    n === 1 ? "1 change waits for the computer." : `${String(n)} changes wait for the computer.`,
  notSaved: (words: string, why: string | undefined) =>
    `Not saved: “${words}”. ${why ?? "The computer refused it."}`,
  dismiss: "Dismiss",

  section: {
    focus: "Focus",
    week: "This week",
    next: "Next",
    changes: "Changes",
  } satisfies Record<TodaySection, string>,
  nothing: "Nothing planned.",
  loading: "Loading…",
  finish: (title: string) => `Done: ${title}`,
  due: (day: string) => `Due ${day}`,
  doneToast: (title: string) => `Done: ${title}`,
  undo: "Undo",

  open: (title: string) => `Open: ${title}`,
  back: "Back",
  brief: "Brief",
  description: "Description",
  thread: "Notes and log",
  knowledge: "Knowledge",
  fromAbove: "From above",
  question: (by: string) => `Question from ${by}`,
  planned: (day: string) => `Planned for ${day}`,
  priority: (n: number) => `Priority ${String(n)}`,
  effort: (effort: string) => `Effort: ${effort}`,
  waitingOn: (who: string) => `Waiting on ${who}`,
  who: (by: string) =>
    by === "user" ? "You" : by === "import" ? "Imported" : by === "agent" ? "An agent" : by,
  notLoaded: "Not loaded yet. It loads when the computer can be reached.",
  nothingYet: "Nothing written yet.",

  newTask: "New task",
  addTask: "Add a task",
  addedTo: (where: string) => `Added to ${where}`,
  inbox: "Inbox",
  waitingList: "Waiting",
  addedLater: "Saved. It goes to the computer when it is back.",
  noTitle: "A task needs a title.",
} as const;
