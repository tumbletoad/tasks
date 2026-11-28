// What a task's card reads from the computer beyond its row in the feed: its Description, its
// notes and log entries, newest first with who wrote each, and its Knowledge (its own pages and
// those known above it); and a page opened from there. Each read is kept under the computer's pin
// and the space with the time it was current, so a card opened while the computer is away shows
// what the phone last read, and how old it is.
import type { Keep } from "./outbox.ts";

/** A note or a log entry: its words, who wrote it, when. */
export interface CardEntry {
  readonly kind: "note" | "log";
  readonly ref: string;
  readonly text: string;
  /** `user`, `import`, or an agent app's name. */
  readonly by: string;
  /** ISO date and time. */
  readonly at: string;
  /** A note from the person to the agents. */
  readonly forAgents?: true;
}

/** A page a card lists, to open and read. */
export interface PageLink {
  readonly ref: string;
  readonly title: string;
  readonly brief: string;
}

/** A level above the task (its project, its area, the space) and its pages. */
export interface Level {
  readonly kind: string;
  readonly title: string;
  readonly pages: readonly PageLink[];
}

export interface CardDetail {
  /** The Description: Markdown, as the person or an agent wrote it. */
  readonly description: string;
  /** Notes and log entries, newest first. */
  readonly entries: readonly CardEntry[];
  readonly pages: readonly PageLink[];
  readonly above: readonly Level[];
}

export interface PageText {
  readonly ref: string;
  readonly title: string;
  readonly brief: string;
  /** Markdown. */
  readonly body: string;
}

/** A read as the card shows it: the computer's now, or the phone's last with its age. */
export type Read<T> =
  | { readonly kind: "read"; readonly value: T; readonly at: number; readonly live: boolean }
  /** Never read on this phone, and the computer cannot be asked now. */
  | { readonly kind: "none" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pageLinks(value: unknown): PageLink[] {
  return list(value)
    .filter(isRecord)
    .filter((p) => typeof p["ref"] === "string")
    .map((p) => ({ ref: text(p["ref"]), title: text(p["title"]), brief: text(p["brief"]) }));
}

function entries(kind: CardEntry["kind"], value: unknown): CardEntry[] {
  return list(value)
    .filter(isRecord)
    .filter((e) => typeof e["text"] === "string" && typeof e["at"] === "string")
    .map((e) => ({
      kind,
      ref: text(e["ref"]),
      text: text(e["text"]),
      by: text(e["author"]),
      at: text(e["at"]),
      ...(e["for_agents"] === true ? { forAgents: true as const } : {}),
    }));
}

/** The card's detail from `task.get`'s answer with its sections, or undefined. */
export function cardOf(body: unknown): CardDetail | undefined {
  const result = isRecord(body) ? body["result"] : undefined;
  if (!isRecord(result) || result["view"] !== "sections") return undefined;
  const sections = isRecord(result["sections"]) ? result["sections"] : {};
  const merged = [...entries("note", sections["notes"]), ...entries("log", sections["log"])];
  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return {
    description: text(sections["context"]),
    entries: merged,
    pages: pageLinks(result["pages"]),
    above: list(result["trail"])
      .filter(isRecord)
      .map((level) => ({
        kind: text(level["kind"]),
        title: text(level["title"]),
        pages: pageLinks(level["pages"]),
      }))
      .filter((level) => level.pages.length > 0),
  };
}

/** A page from `page.read`'s answer, or undefined. */
export function pageOf(body: unknown): PageText | undefined {
  const result = isRecord(body) ? body["result"] : undefined;
  if (!isRecord(result) || result["view"] !== "page") return undefined;
  return {
    ref: text(result["ref"]),
    title: text(result["title"]),
    brief: text(result["brief"]),
    body: text(result["body"]),
  };
}

/** What the card asks the computer for. */
export const CARD_READ = {
  path: "/api/v1/op/task.get",
  body: (task: string) => ({ task, sections: ["context", "notes", "log"], log_limit: 50 }),
} as const;
export const PAGE_READ = {
  path: "/api/v1/op/page.read",
  body: (ref: string) => ({ target: ref }),
} as const;

const FILE = "reads";
/** The most cards and pages kept of one space: the newest reads. */
const KEPT = 40;

interface Kept<T> {
  readonly at: number;
  readonly value: T;
}

interface Box {
  readonly cards: Readonly<Record<string, Kept<CardDetail>>>;
  readonly pages: Readonly<Record<string, Kept<PageText>>>;
}

/** The newest `KEPT` of `all`. */
function newest<T>(all: Record<string, Kept<T>>): Record<string, Kept<T>> {
  return Object.fromEntries(
    Object.entries(all)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEPT),
  );
}

/** The phone's last reads of cards and pages, under the computer's pin and the space. */
export class Reads {
  readonly #keep: Keep;
  readonly #key: string;

  constructor(keep: Keep, pin: string, space: string) {
    this.#keep = keep;
    this.#key = `${pin} ${space}`;
  }

  #all(): Record<string, unknown> {
    const raw = this.#keep.read(FILE);
    if (raw === null || raw === "") return {};
    try {
      const value = JSON.parse(raw) as unknown;
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  }

  #box(): Box {
    const box = this.#all()[this.#key];
    return {
      cards: isRecord(box) && isRecord(box["cards"]) ? (box["cards"] as Box["cards"]) : {},
      pages: isRecord(box) && isRecord(box["pages"]) ? (box["pages"] as Box["pages"]) : {},
    };
  }

  #save(box: Box): void {
    const all = this.#all();
    all[this.#key] = box;
    this.#keep.write(FILE, JSON.stringify(all));
  }

  card(task: string): Kept<CardDetail> | undefined {
    return this.#box().cards[task];
  }

  page(ref: string): Kept<PageText> | undefined {
    return this.#box().pages[ref];
  }

  keepCard(task: string, value: CardDetail, at: number): void {
    const box = this.#box();
    this.#save({ ...box, cards: newest({ ...box.cards, [task]: { at, value } }) });
  }

  keepPage(ref: string, value: PageText, at: number): void {
    const box = this.#box();
    this.#save({ ...box, pages: newest({ ...box.pages, [ref]: { at, value } }) });
  }

  /** The phone was removed: what it read goes. */
  forget(): void {
    const all = this.#all();
    Reflect.deleteProperty(all, this.#key);
    this.#keep.write(FILE, JSON.stringify(all));
  }
}
