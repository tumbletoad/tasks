// The files in packages/contracts/generated/ (A3 3.2.2). Each is a pure function of the registry:
// no clock, no paths, no environment, so the output is the same on every machine.
import { AUTO_FIELDS, faceFields, kebab, keyValueFields, type FieldInfo } from "../cli.ts";
import { ACTOR_KINDS_BY_CLASS, cliFaces, type AnyEntry, type CliFace } from "../define.ts";
import { ERROR_CODES, EXIT_CODES, VERSION_REASONS } from "../errors.ts";
import { routePath } from "../http.ts";
import {
  JSON_SCHEMA_DIALECT,
  inputJsonSchema,
  mcpTool,
  outputJsonSchema,
  type McpTool,
} from "../json-schema.ts";
import { definitionReport } from "./report.ts";
import { stableJson } from "./stable-json.ts";

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Every file of packages/contracts/generated/, keyed by file name. */
export function renderArtefacts(entries: readonly AnyEntry[]): Map<string, string> {
  const sorted = [...entries].sort(byName);
  const tools = stableJson(mcpTools(sorted));
  // The report measures the definitions as the generated file holds them, keys sorted.
  const served = (JSON.parse(tools) as { tools: McpTool[] }).tools;
  return new Map([
    ["cli-spec.json", stableJson(cliSpec(sorted))],
    ["client.ts", clientTs(sorted)],
    ["http-routes.ts", httpRoutesTs(sorted)],
    ["mcp-definitions.json", stableJson(definitionReport(served))],
    ["mcp-tools.json", tools],
    ["rpc-methods.json", stableJson(rpcMethods(sorted))],
  ]);
}

/** `mcp-tools.json`: the agent-allowed entries with an MCP face, as `tools/list` returns them. */
export function mcpTools(entries: readonly AnyEntry[]): { tools: McpTool[] } {
  const tools = entries
    .map(mcpTool)
    .filter((t): t is McpTool => t !== undefined)
    .sort(byName);
  return { tools };
}

/** `rpc-methods.json`: every entry with its metadata and JSON Schemas, for A2's op/call and op/list. */
export function rpcMethods(entries: readonly AnyEntry[]) {
  return {
    version: 1,
    dialect: JSON_SCHEMA_DIALECT,
    methods: entries.map((e) => ({
      name: e.name,
      summary: e.summary,
      kind: e.kind,
      actors: e.actors,
      actorKinds: ACTOR_KINDS_BY_CLASS[e.actors],
      scope: e.scope,
      remote: e.remote,
      audience: e.audience,
      ops: e.ops,
      errors: e.errors,
      input: inputJsonSchema(e),
      output: outputJsonSchema(e),
    })),
  };
}

function flagSpec(info: FieldInfo, face: CliFace) {
  const short = face.short?.[info.name];
  return {
    flag: `--${face.flags?.[info.name] ?? kebab(info.name)}`,
    field: info.path,
    type: info.scalar ?? info.repeatable,
    repeat: info.repeatable !== undefined,
    required: info.required,
    help: info.description,
    ...(info.values === undefined ? {} : { values: info.values }),
    ...(short === undefined ? {} : { short: `-${short}` }),
    ...(info.userOnly ? { userOnly: true } : {}),
  };
}

/** One verb of `cli-spec.json`. */
export function verbSpec(entry: AnyEntry, face: CliFace) {
  const fields = faceFields(entry, face);
  const positional = face.positional ?? [];
  const fixed = face.fixed ?? {};
  const auto = AUTO_FIELDS.filter((name) => fields.get(name)?.path === name);
  const skip = new Set<string>([
    ...positional,
    ...Object.keys(fixed),
    ...(face.exclude ?? []),
    ...auto,
    ...(face.keyValue === undefined ? [] : [face.keyValue]),
    ...(face.item === undefined ? [] : [face.item]),
  ]);
  const flags: ReturnType<typeof flagSpec>[] = [];
  const inputOnly: string[] = [];
  for (const info of fields.values()) {
    if (skip.has(info.name)) continue;
    if (info.scalar !== undefined || info.repeatable !== undefined)
      flags.push(flagSpec(info, face));
    else inputOnly.push(info.path);
  }
  let keyValue: { field: string; keys: Record<string, unknown>[] } | undefined;
  if (face.keyValue !== undefined) {
    const keys: Record<string, unknown>[] = [];
    for (const info of keyValueFields(entry, face.keyValue)?.values() ?? []) {
      if (info.scalar === undefined) {
        inputOnly.push(info.path);
        continue;
      }
      keys.push({
        key: info.name,
        field: info.path,
        type: info.scalar,
        help: info.description,
        ...(info.values === undefined ? {} : { values: info.values }),
      });
    }
    keyValue = { field: face.keyValue, keys };
  }
  return {
    verb: face.verb,
    entry: entry.name,
    summary: entry.summary,
    kind: entry.kind,
    actors: entry.actors,
    positionals: positional.map((name) => {
      const info = fields.get(name);
      return {
        name,
        field: info?.path ?? name,
        type: info?.scalar,
        required: info?.required ?? false,
        help: info?.description ?? "",
        ...(info?.values === undefined ? {} : { values: info.values }),
      };
    }),
    flags,
    ...(keyValue === undefined ? {} : { keyValue }),
    ...(face.item === undefined ? {} : { item: face.item }),
    ...(Object.keys(fixed).length === 0 ? {} : { fixed }),
    auto,
    inputOnly,
  };
}

/** `cli-spec.json`: the operation verbs for A2's CLI parser, with error classes and exit codes. */
export function cliSpec(entries: readonly AnyEntry[]) {
  const verbs = entries
    .flatMap((entry) => cliFaces(entry).map((face) => verbSpec(entry, face)))
    .sort((a, b) => (a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0));
  return {
    version: 1,
    common: [
      { flag: "--json", help: "Print the result, or the error, as one JSON document" },
      { flag: "--input", value: "<file or ->", help: "Read the input JSON from a file or stdin" },
    ],
    auto: {
      base: "The CLI reads the task first and sends that read's as_of",
      cwd: "The CLI's working folder",
      request_id: "From --request-id, or generated and printed",
    },
    errors: Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, spec]) => [
        code,
        { class: spec.class, exit: EXIT_CODES[spec.class] },
      ]),
    ),
    versionReasons: VERSION_REASONS,
    exitCodes: EXIT_CODES,
    verbs,
  };
}

const HEADER = ["// Generated by `pnpm gen` from packages/contracts/src (A3 3.2.2). Do not edit."];

const literal = (value: string) => JSON.stringify(value);

/** `http-routes.ts`: `POST /api/v1/op/<name>` for every entry with a UI face. */
export function httpRoutesTs(entries: readonly AnyEntry[]): string {
  const routes = entries
    .filter((e) => e.faces.ui === true)
    .map(
      (e) =>
        `  { entry: ${literal(e.name)}, method: "POST", path: ${literal(routePath(e.name))} },`,
    );
  return [
    ...HEADER,
    '// The body is the input JSON. A success is 200 {"result": ...}. An error is',
    '// {"error": {code, message, hint, data}} with the status of its code (src/errors.ts).',
    "",
    "export const httpRoutes = [",
    ...routes,
    "] as const;",
    "",
    "export type HttpRoute = (typeof httpRoutes)[number];",
    "",
  ].join("\n");
}

interface ClientNode {
  methods: AnyEntry[];
  children: Map<string, ClientNode>;
}

function comment(text: string): string {
  return text.replaceAll("*/", "* /");
}

function renderNode(node: ClientNode, indent: string): string[] {
  const lines: string[] = [];
  const keys = [...new Set([...node.children.keys(), ...node.methods.map(leafOf)])].sort();
  for (const key of keys) {
    const method = node.methods.find((e) => leafOf(e) === key);
    if (method !== undefined) {
      const n = literal(method.name);
      lines.push(`${indent}/** ${comment(method.summary)} */`);
      lines.push(
        `${indent}${key}: (input: InputOf<${n}>): Promise<OutputOf<${n}>> => call(${n}, input),`,
      );
    }
    const child = node.children.get(key);
    if (child !== undefined) {
      lines.push(`${indent}${key}: {`, ...renderNode(child, `${indent}  `), `${indent}},`);
    }
  }
  return lines;
}

function leafOf(entry: AnyEntry): string {
  const parts = entry.name.split(".");
  return parts[parts.length - 1] ?? entry.name;
}

/** `client.ts`: the typed client of the browser UI (A5), one method per entry with a UI face. */
export function clientTs(entries: readonly AnyEntry[]): string {
  const root: ClientNode = { methods: [], children: new Map() };
  for (const entry of entries.filter((e) => e.faces.ui === true)) {
    const parts = entry.name.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { methods: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.methods.push(entry);
  }
  return [
    ...HEADER,
    "// The typed client of the browser UI (A5): `api.task.update(input)` posts to",
    "// /api/v1/op/task.update and returns the result, or throws AppError.",
    'import { createCaller, type ClientTransport } from "../src/client-runtime.ts";',
    'import type { InputOf, OutputOf } from "../src/registry.ts";',
    "",
    "export type { ClientTransport };",
    "",
    "export function createClient(transport: ClientTransport) {",
    "  const call = createCaller(transport);",
    "  return {",
    ...renderNode(root, "    "),
    "  };",
    "}",
    "",
    "export type Client = ReturnType<typeof createClient>;",
    "",
  ].join("\n");
}
