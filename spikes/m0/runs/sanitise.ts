// The stream sanitiser of lab run N (M0.11, N05). It turns one stdout stream of `claude -p`
// (stream-json) or `codex exec --json` into fixture text by the fixture schema
// (tests/stream-schema.ts): every allow-listed field has one treatment with a fixed output, so a
// known FIELD never lets an observed VALUE through. Enums keep only vocabulary values; IDs, names,
// paths, times and map keys become synthetic values, consistent within one stream; text, numbers
// and name lists become fixture values. A field the schema does not name is dropped, and an event
// type it does not know becomes {"type":"unknown-event"}.
//
// The inventory says, per event key and field path, the JSON types seen and what was really done
// (TREATMENTS in the schema). A field name that is not on the allow-list is never written: it
// shows as a placeholder `<unknown-n>`; map keys show as `<map-key>`. Event order and line
// structure stay.
import {
  CONSTS,
  NAME_KEEP,
  NUMBERS,
  UNKNOWN_EVENT,
  UNKNOWN_VALUE,
  VERSION,
  VERSION_PLACEHOLDER,
  VOCAB,
  BASE_EPOCH,
  BASE_TIME,
  CLAUDE,
  CODEX,
  FIXTURE_SIGNATURE,
  FIXTURE_TEXT,
  LIST_ELEMENT_FIELDS,
  NOT_JSON_LINE,
  NOT_OBJECT_LINE,
  errorClassOf,
  eventKeyOf,
  fixturePath,
  isLeaf,
  listVocabulary,
  pathLeaf,
  specFor,
  syntheticId,
  syntheticKey,
  syntheticName,
  type CliKind,
  type IdKind,
  type KeyKind,
  type Leaf,
  type NameTable,
  type Os,
  type Spec,
  type Treatment,
} from "../../../tests/stream-schema.ts";

export type { CliKind, Os };
export { NOT_JSON_LINE, NOT_OBJECT_LINE };

/** JSON.stringify, typed as it behaves: undefined for undefined, a function or a symbol. */
const json = (v: unknown): string | undefined => JSON.stringify(v);
const jsonKey = (v: unknown) => `${typeof v}:${json(v) ?? "undefined"}`;

/** Replacement state for one stream: IDs, names, paths, times and keys stay consistent in it. */
export class Replacer {
  private readonly ids = new Map<string, string>();
  private idCount = 0;
  private itemCount = 0;
  private readonly names = new Map<string, string>();
  private readonly nameCount: Record<NameTable, number> = { model: 0, window: 0 };
  private readonly keys = new Map<string, string>();
  private readonly keyCount = { memory: 0, "agent-type": 0 };
  private readonly paths = new Map<string, string>();
  private readonly times = new Map<string, number>();

  readonly os: Os;
  constructor(os: Os) {
    this.os = os;
  }

  id(kind: IdKind, value: unknown): string {
    // Session, event and thread IDs share one form, so they share one table.
    const family = kind === "session" || kind === "event" || kind === "thread" ? "uuid" : kind;
    const k = `${family}\0${jsonKey(value)}`;
    const known = this.ids.get(k);
    if (known !== undefined) return known;
    const out =
      kind === "item" ? syntheticId("item", this.itemCount++) : syntheticId(kind, ++this.idCount);
    this.ids.set(k, out);
    return out;
  }

  name(table: NameTable, value: unknown): string {
    const k = `${table}\0${jsonKey(value)}`;
    const known = this.names.get(k);
    if (known !== undefined) return known;
    const out = syntheticName(table, ++this.nameCount[table]);
    this.names.set(k, out);
    return out;
  }

  key(kind: KeyKind, value: string): string {
    if (kind === "model" || kind === "window") {
      return NAME_KEEP[kind].includes(value) ? value : this.name(kind, value);
    }
    if (kind === "tool-use") return this.id("tool-use", value);
    const k = `${kind}\0${value}`;
    const known = this.keys.get(k);
    if (known !== undefined) return known;
    const out = syntheticKey(kind, ++this.keyCount[kind]);
    this.keys.set(k, out);
    return out;
  }

  path(value: unknown): string {
    if (value === "") return "";
    const k = jsonKey(value);
    const known = this.paths.get(k);
    if (known !== undefined) return known;
    const out = fixturePath(this.os, pathLeaf(this.paths.size + 1));
    this.paths.set(k, out);
    return out;
  }

  private readonly epochs = new Map<string, number>();

  /** The n-th distinct value of the stream in `table`, as an index into a fixed series. */
  private static index(table: Map<string, number>, value: unknown): number {
    const k = jsonKey(value);
    const known = table.get(k);
    if (known !== undefined) return known;
    const i = table.size;
    table.set(k, i);
    return i;
  }

  time(value: unknown): string {
    return new Date(BASE_TIME + Replacer.index(this.times, value) * 1000).toISOString();
  }

  epoch(value: unknown): number {
    return BASE_EPOCH + Replacer.index(this.epochs, value) * 3600;
  }
}

// -------------------------------------------------------------------------------------------
// The inventory: event key -> field path -> JSON types and treatments. Names and types only.
export interface FieldInfo {
  types: string[];
  treatment: Treatment[];
}
export interface EventInfo {
  count: number;
  fields: Record<string, FieldInfo>;
}
export type Inventory = Record<string, Record<string, EventInfo>>;

const jsonType = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;

export class Collector {
  readonly inventory: Inventory = {};
  private current: EventInfo | undefined;
  private readonly unknownNames = new Map<string, string>();

  event(cli: CliKind, key: string): void {
    const byCli = (this.inventory[cli] ??= {});
    this.current = byCli[key] ??= { count: 0, fields: {} };
    this.current.count++;
  }

  note(path: string, value: unknown, treatment: Treatment): void {
    if (this.current === undefined || path === "") return;
    const f = (this.current.fields[path] ??= { types: [], treatment: [] });
    const t = jsonType(value);
    if (!f.types.includes(t)) f.types.push(t);
    if (!f.treatment.includes(treatment)) f.treatment.push(treatment);
  }

  /** The placeholder for a field name that is not on the allow-list at its position. */
  unknown(name: string): string {
    const known = this.unknownNames.get(name);
    if (known !== undefined) return known;
    const out = `<unknown-${String(this.unknownNames.size + 1)}>`;
    this.unknownNames.set(name, out);
    return out;
  }

  /** A field that goes, and every field below it (their names as placeholders). */
  dropped(path: string, value: unknown): void {
    this.note(path, value, "dropped");
    if (Array.isArray(value)) for (const x of value) this.dropped(`${path}[]`, x);
    else if (typeof value === "object" && value !== null) {
      const dot = path === "" ? "" : `${path}.`;
      for (const [k, x] of Object.entries(value)) this.dropped(`${dot}${this.unknown(k)}`, x);
    }
  }
}

const DROP = Symbol("drop");

/** One leaf: its fixture output and what was done. Never the input unless the vocabulary has it. */
export function leafValue(
  leaf: Leaf,
  v: unknown,
  r: Replacer,
): { out: unknown; treatment: Treatment } {
  if (v === null) return { out: null, treatment: "kept" };
  switch (leaf.t) {
    case "tag":
      // Only reached with the value that selected the spec (an event or variant tag).
      return { out: v, treatment: "kept" };
    case "enum":
      return typeof v === "string" && (VOCAB[leaf.vocab] as readonly string[]).includes(v)
        ? { out: v, treatment: "kept" }
        : { out: UNKNOWN_VALUE, treatment: "placeholder" };
    case "bool":
      return typeof v === "boolean"
        ? { out: v, treatment: "kept" }
        : { out: null, treatment: "placeholder" };
    case "int":
      return Number.isInteger(v) && (v as number) >= leaf.min && (v as number) <= leaf.max
        ? { out: v, treatment: "kept" }
        : { out: null, treatment: "placeholder" };
    case "null":
      return { out: null, treatment: "placeholder" };
    case "const":
      return { out: CONSTS[leaf.kind], treatment: "fixture-value" };
    case "name":
      return typeof v === "string" && NAME_KEEP[leaf.table].includes(v)
        ? { out: v, treatment: "kept" }
        : { out: r.name(leaf.table, v), treatment: "synthetic-name" };
    case "path":
      return { out: r.path(v), treatment: "fixture-path" };
    case "version":
      return typeof v === "string" && VERSION.test(v)
        ? { out: v, treatment: "kept" }
        : { out: VERSION_PLACEHOLDER, treatment: "placeholder" };
    case "id":
      return { out: r.id(leaf.kind, v), treatment: "synthetic-id" };
    case "time":
      return { out: r.time(v), treatment: "series-time" };
    case "epoch":
      return { out: r.epoch(v), treatment: "series-time" };
    case "text":
      return { out: v === "" ? "" : FIXTURE_TEXT, treatment: "fixture-text" };
    case "error":
      return {
        out: `Fixture error message (${errorClassOf(typeof v === "string" ? v : "")}).`,
        treatment: "fixture-error-text",
      };
    case "signature":
      return { out: v === "" ? "" : FIXTURE_SIGNATURE, treatment: "fixture-text" };
    case "number":
      return { out: NUMBERS[leaf.kind], treatment: "fixture-number" };
    case "list": {
      if (!Array.isArray(v)) return { out: [], treatment: "placeholder" };
      if (v.length === 0) return { out: [], treatment: "rebuilt-list" };
      const { invented, keep } = listVocabulary(leaf.list, r.os);
      const found = keep.filter((k) => v.includes(k));
      return { out: [...invented, ...found], treatment: "rebuilt-list" };
    }
  }
}

function walk(spec: Spec, v: unknown, path: string, r: Replacer, c: Collector): unknown {
  if (isLeaf(spec)) {
    const { out, treatment } = leafValue(spec, v, r);
    c.note(path, v, treatment);
    if (spec.t === "list" && Array.isArray(v)) {
      // The observed list's shape for the inventory (types, allow-listed element field names).
      const fields = LIST_ELEMENT_FIELDS[spec.list] ?? [];
      for (const x of v) {
        c.note(`${path}[]`, x, "rebuilt-list");
        if (typeof x !== "object" || x === null || Array.isArray(x)) continue;
        for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
          c.note(`${path}[].${fields.includes(k) ? k : c.unknown(k)}`, y, "rebuilt-list");
        }
      }
    }
    return out;
  }
  if (v === null) {
    c.note(path, v, "kept");
    return null;
  }
  if ("oneOf" in spec) {
    const t = jsonType(v);
    const sub = t === "string" || t === "array" || t === "object" ? spec.oneOf[t] : undefined;
    if (sub === undefined) {
      c.dropped(path, v);
      return DROP;
    }
    return walk(sub, v, path, r, c);
  }
  if ("arr" in spec) {
    if (!Array.isArray(v)) {
      c.dropped(path, v);
      return DROP;
    }
    const kept = spec.probeOnly === true ? v.filter((x) => isProbeServer(x)) : v;
    c.note(path, v, kept.length === v.length ? "container" : "rebuilt-without-other-servers");
    for (const x of v) if (!kept.includes(x)) c.dropped(`${path}[]`, x);
    return kept.map((x) => walk(spec.arr, x, `${path}[]`, r, c)).filter((x) => x !== DROP);
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    c.dropped(path, v);
    return DROP;
  }
  const o = v as Record<string, unknown>;
  const dot = path === "" ? "" : `${path}.`;
  const out: Record<string, unknown> = {};
  if ("map" in spec) {
    c.note(path, v, "container");
    for (const [k, x] of Object.entries(o)) {
      c.note(path, v, "synthetic-key");
      const y = walk(spec.map, x, `${dot}<map-key>`, r, c);
      if (y !== DROP) out[r.key(spec.key, k)] = y;
    }
    return out;
  }
  let fields: Record<string, Spec>;
  if ("by" in spec) {
    const tag = o[spec.by];
    if (typeof tag !== "string" || !Object.hasOwn(spec.cases, tag)) {
      // An unknown variant: its tag becomes the placeholder, everything else goes.
      c.note(path, v, "container");
      for (const [k, x] of Object.entries(o)) {
        if (k === spec.by) {
          out[k] = UNKNOWN_VALUE;
          c.note(`${dot}${k}`, x, "placeholder");
        } else c.dropped(`${dot}${c.unknown(k)}`, x);
      }
      return out;
    }
    fields = { [spec.by]: { t: "tag" }, ...(spec.cases[tag] as Record<string, Spec>) };
  } else fields = spec.obj;
  c.note(path, v, "container");
  for (const [k, x] of Object.entries(o)) {
    const s = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (s === undefined) {
      c.dropped(`${dot}${c.unknown(k)}`, x);
      continue;
    }
    const y = walk(s, x, `${dot}${k}`, r, c);
    if (y !== DROP) out[k] = y;
  }
  return out;
}

const isProbeServer = (x: unknown) =>
  typeof x === "object" && x !== null && (x as Record<string, unknown>)["name"] === "tasks";

/** One event: by its spec, or `{"type":"unknown-event"}` for a type the schema does not know. */
export function sanitiseEvent(
  cli: CliKind,
  event: Record<string, unknown>,
  r: Replacer,
  c: Collector,
): Record<string, unknown> {
  const spec = specFor(cli, event);
  c.event(cli, eventKeyOf(cli, event));
  if (spec === undefined) {
    for (const [k, x] of Object.entries(event)) {
      if (k === "type") c.note("type", x, "placeholder");
      else c.dropped(c.unknown(k), x);
    }
    return { ...UNKNOWN_EVENT };
  }
  return walk(spec, event, "", r, c) as Record<string, unknown>;
}

export interface FinalLine {
  /** `complete`, `partial-from-run` (the run's own cut line, rebuilt) or `cut-by-sanitiser`. */
  kind: "complete" | "partial-from-run" | "cut-by-sanitiser" | "empty";
}

export interface Sanitised {
  stream: string;
  inventory: Inventory;
  truncated: FinalLine;
}

const KNOWN_TYPES = new Set([
  ...Object.keys(CLAUDE).map((k) => k.split("/")[0] as string),
  ...Object.keys(CODEX),
]);

/**
 * A whole stream. Each line becomes one sanitised JSON line; a line that is not JSON becomes the
 * fixed line NOT_JSON_LINE. A partial last line from the run (no newline at the end) is rebuilt
 * as a prefix of a minimal event of its type (a known type only, else `unknown-event`). With
 * `cutFinalLine`, the last complete line is cut in half and loses its newline, to stand for a kill
 * in the middle of a write.
 */
export function sanitiseStream(
  cli: CliKind,
  os: Os,
  text: string,
  options: { cutFinalLine?: boolean } = {},
): Sanitised {
  const r = new Replacer(os);
  const c = new Collector();
  if (text === "") return { stream: "", inventory: c.inventory, truncated: { kind: "empty" } };
  const parts = text.split("\n");
  const tail = parts.pop() ?? "";
  const lines: string[] = [];
  for (const line of parts) {
    const body = line.replace(/\r$/, "");
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      lines.push(NOT_JSON_LINE);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      lines.push(NOT_OBJECT_LINE);
      continue;
    }
    lines.push(JSON.stringify(sanitiseEvent(cli, value as Record<string, unknown>, r, c)));
  }
  let stream = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  let kind: FinalLine["kind"] = "complete";
  if (tail !== "") {
    const seen = /"type"\s*:\s*"([A-Za-z0-9_.]{1,48})"/.exec(tail)?.[1];
    const type = seen !== undefined && KNOWN_TYPES.has(seen) ? seen : UNKNOWN_EVENT.type;
    const stub = JSON.stringify({ type, fixture: "the run ended inside this line" });
    stream += stub.slice(0, Math.max(1, Math.min(tail.length, stub.length - 1)));
    kind = "partial-from-run";
  } else if (options.cutFinalLine === true && lines.length > 0) {
    stream = cutLastLine(lines);
    kind = "cut-by-sanitiser";
  }
  return { stream, inventory: c.inventory, truncated: { kind } };
}

/** The lines with the last one cut in half and no final newline. */
export function cutLastLine(lines: readonly string[]): string {
  const last = lines[lines.length - 1] ?? "";
  const head = lines.slice(0, -1);
  return `${head.join("\n")}${head.length > 0 ? "\n" : ""}${last.slice(0, Math.max(1, Math.floor(last.length / 2)))}`;
}

/** Inventories of several streams in one: counts add up, types and treatments join, sorted. */
export function mergeInventories(list: readonly Inventory[]): Inventory {
  const out: Inventory = {};
  for (const inv of list) {
    for (const [cli, events] of Object.entries(inv)) {
      const o = (out[cli] ??= {});
      for (const [key, info] of Object.entries(events)) {
        const e = (o[key] ??= { count: 0, fields: {} });
        e.count += info.count;
        for (const [path, f] of Object.entries(info.fields)) {
          const g = (e.fields[path] ??= { types: [], treatment: [] });
          for (const t of f.types) if (!g.types.includes(t)) g.types.push(t);
          for (const t of f.treatment) if (!g.treatment.includes(t)) g.treatment.push(t);
        }
      }
    }
  }
  const sorted: Inventory = {};
  for (const cli of Object.keys(out).sort()) {
    const events = out[cli] ?? {};
    const s: Record<string, EventInfo> = {};
    for (const key of Object.keys(events).sort()) {
      const e = events[key] as EventInfo;
      const fields: Record<string, FieldInfo> = {};
      for (const path of Object.keys(e.fields).sort()) {
        const f = e.fields[path] as FieldInfo;
        fields[path] = { types: [...f.types].sort(), treatment: [...f.treatment].sort() };
      }
      s[key] = { count: e.count, fields };
    }
    sorted[cli] = s;
  }
  return sorted;
}
