// data/metadata.json (A7 3.15.2, Metadata): one object keyed by task ID, with
// `category`, `project`, `status`, `owner`, `priority`, optional `rank`, `next`, `evidence`,
// `source_date`, `reviewed`, `confidence`, optional `due`, `sources` and `paths`. A missing file is
// `{}`. A value of the wrong type is dropped and reported; an unknown key is kept as written.

import { readJson, isObject } from "./json.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { problem, type Problem, type ProblemField } from "./problems.ts";
import { isIsoDate, type Source } from "./text.ts";

export const METADATA_FILE = "data/metadata.json";

export const STATUSES = ["open", "waiting", "needs_review", "delegated", "backlog"] as const;
export type PrototypeStatus = (typeof STATUSES)[number];

export interface MetadataSource {
  /** Empty when the row has no label. */
  readonly label: string;
  readonly url: string;
}

export interface MetadataEntry {
  readonly id: string;
  readonly category?: string;
  readonly project?: string;
  readonly status?: PrototypeStatus;
  readonly owner?: string;
  /** `P1` to `P3` as 1 to 3. */
  readonly priority?: 1 | 2 | 3;
  readonly rank?: number;
  readonly next?: string;
  readonly evidence?: string;
  /** YYYY-MM-DD, only when it is a calendar date. */
  readonly sourceDate?: string;
  /** YYYY-MM-DD, only when it is a calendar date. */
  readonly reviewed?: string;
  /** Free text, kept as written. A JSON boolean is kept as its JSON text; a number is dropped with
   * `field-type`, since its text as written is already lost. */
  readonly confidence?: string;
  /** YYYY-MM-DD, only when it is a calendar date. */
  readonly due?: string;
  readonly sources: readonly MetadataSource[];
  /** As written. A path that is not absolute is kept and reported. */
  readonly paths: readonly string[];
  /** Every key the prototype's grammar does not name, with its JSON value. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface MetadataParse {
  readonly present: boolean;
  /** In the file's key order. */
  readonly entries: ReadonlyMap<string, MetadataEntry>;
  readonly problems: Problem[];
}

const KNOWN = new Set([
  "category",
  "project",
  "status",
  "owner",
  "priority",
  "rank",
  "next",
  "evidence",
  "source_date",
  "reviewed",
  "confidence",
  "due",
  "sources",
  "paths",
]);

const PRIORITIES = new Map<string, 1 | 2 | 3>([
  ["P1", 1],
  ["P2", 2],
  ["P3", 3],
]);

/** A POSIX absolute path, a Windows drive path or a UNC path. */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

export function parseMetadata(
  source: Source | undefined,
  overrides?: Partial<Limits>,
): MetadataParse {
  const limits = limitsWith(overrides);
  const entries = new Map<string, MetadataEntry>();
  if (source === undefined) return { present: false, entries, problems: [] };
  const read = readJson(source, METADATA_FILE, limits.jsonBytes);
  const problems = read.problems;
  if (!read.ok) return { present: true, entries, problems };
  if (!isObject(read.value)) {
    problems.push(problem("json-wrong-shape", { file: METADATA_FILE }));
    return { present: true, entries, problems };
  }
  // The bound counts every entry examined, kept or not, so invalid entries cannot run past it.
  for (const [index, [id, value]] of Object.entries(read.value).entries()) {
    if (index >= limits.entries) {
      problems.push(problem("too-many-entries", { file: METADATA_FILE }));
      break;
    }
    if (!isObject(value)) {
      problems.push(problem("entry-not-object", { file: METADATA_FILE, task: id }));
      continue;
    }
    entries.set(id, entryFrom(id, value, limits, problems));
  }
  return { present: true, entries, problems };
}

function entryFrom(
  id: string,
  raw: Record<string, unknown>,
  limits: Limits,
  problems: Problem[],
): MetadataEntry {
  const report = (code: Parameters<typeof problem>[0], field: ProblemField, index?: number) => {
    problems.push(problem(code, { file: METADATA_FILE, task: id, field, index }));
  };
  const text = (field: ProblemField): string | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    report("field-type", field);
    return undefined;
  };
  const date = (field: ProblemField): string | undefined => {
    const value = text(field);
    if (value === undefined || isIsoDate(value)) return value;
    report("date-invalid", field);
    return undefined;
  };

  const entry: { -readonly [K in keyof MetadataEntry]: MetadataEntry[K] } = {
    id,
    sources: [],
    paths: [],
    extra: Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN.has(key))),
  };
  const set = <K extends keyof MetadataEntry>(key: K, value: MetadataEntry[K] | undefined) => {
    if (value !== undefined) entry[key] = value;
  };
  set("category", text("category"));
  set("project", text("project"));
  set("owner", text("owner"));
  set("next", text("next"));
  set("evidence", text("evidence"));
  set("sourceDate", date("source_date"));
  set("reviewed", date("reviewed"));
  set("due", date("due"));

  const status = raw["status"];
  if (typeof status === "string") {
    if ((STATUSES as readonly string[]).includes(status)) entry.status = status as PrototypeStatus;
    else report("status-unknown", "status");
  } else if (status !== undefined) report("field-type", "status");

  const priority = raw["priority"];
  const level = typeof priority === "string" ? PRIORITIES.get(priority) : undefined;
  if (level !== undefined) entry.priority = level;
  else if (typeof priority === "string") report("priority-invalid", "priority");
  else if (priority !== undefined) report("field-type", "priority");

  const rank = raw["rank"];
  if (typeof rank === "number" && Number.isFinite(rank)) entry.rank = rank;
  else if (rank !== undefined) report("field-type", "rank");

  // Free text. A number is dropped: JSON.parse has already rounded it (1e-400, 2^53 + 1), so its
  // text as written cannot be kept. A boolean is kept as its JSON text, which is exact.
  const confidence = raw["confidence"];
  if (typeof confidence === "string") entry.confidence = confidence;
  else if (typeof confidence === "boolean") entry.confidence = JSON.stringify(confidence);
  else if (confidence !== undefined) report("field-type", "confidence");

  const list = (field: "sources" | "paths"): unknown[] => {
    const value = raw[field];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      report("field-type", field);
      return [];
    }
    if (value.length <= limits.itemsPerEntry) return value as unknown[];
    report("too-many-items", field);
    return (value as unknown[]).slice(0, limits.itemsPerEntry);
  };

  const sources: MetadataSource[] = [];
  for (const [i, item] of list("sources").entries()) {
    const url = isObject(item) ? item["url"] : undefined;
    const label = isObject(item) ? (item["label"] ?? "") : undefined;
    if (typeof url === "string" && url !== "" && typeof label === "string") {
      sources.push({ label, url });
    } else report("source-invalid", "sources", i);
  }
  entry.sources = sources;

  const paths: string[] = [];
  for (const [i, item] of list("paths").entries()) {
    if (typeof item !== "string") {
      report("field-type", "paths", i);
      continue;
    }
    if (!ABSOLUTE.test(item)) report("path-not-absolute", "paths", i);
    paths.push(item);
  }
  entry.paths = paths;
  return entry;
}
