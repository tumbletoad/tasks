// How a CLI face maps onto an entry's input. The registry check and
// the `cli-spec.json` generator both use it.
import type { z } from "zod";
import { coreOf, defOf, descriptionOf, type AnyEntry, type CliFace } from "./define.ts";
import { inputJsonSchema, type JsonSchema } from "./json-schema.ts";

/**
 * Fields the CLI fills itself and never offers as arguments: `base` from a read just before the
 * write, `cwd` from its working folder and `request_id` from the global `--request-id` or a fresh
 * one.
 */
export const AUTO_FIELDS = ["base", "cwd", "request_id"] as const;

export type ScalarType = "string" | "integer" | "number" | "boolean";

export interface FieldInfo {
  /** The field name, as faces and flags refer to it. */
  readonly name: string;
  /** Where the value goes in the input: `title`, or `tasks[].title` for an item field. */
  readonly path: string;
  readonly schema: z.ZodType;
  readonly json: JsonSchema;
  readonly required: boolean;
  readonly description: string;
  readonly userOnly: boolean;
  /** Set for scalars and enums, which a flag can carry. */
  readonly scalar: ScalarType | undefined;
  /** Set for arrays of scalars, which a repeated flag can carry. */
  readonly repeatable: ScalarType | undefined;
  readonly values: readonly (string | number | boolean)[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The scalar type a JSON Schema allows, or undefined for objects, arrays and unions. */
export function scalarOf(json: JsonSchema): ScalarType | undefined {
  const type = json["type"];
  if (type === "string" || type === "integer" || type === "number" || type === "boolean")
    return type;
  return undefined;
}

/**
 * `string` for a union with a free text form beside its other forms, such as a place (`"cwd"`, an
 * absolute folder, or a root and a path): an argument carries the text form, and the other forms
 * go through `--input`.
 */
function textFormOf(json: JsonSchema): ScalarType | undefined {
  const forms = json["anyOf"];
  if (!Array.isArray(forms)) return undefined;
  return forms.some((form) => isRecord(form) && form["type"] === "string" && !("const" in form))
    ? "string"
    : undefined;
}

function valuesOf(json: JsonSchema): (string | number | boolean)[] | undefined {
  if (Array.isArray(json["enum"])) return json["enum"] as (string | number | boolean)[];
  const value = json["const"];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [value];
  }
  return undefined;
}

function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const def = defOf(coreOf(schema));
  return def.type === "object" ? (def["shape"] as Record<string, z.ZodType>) : undefined;
}

function infos(
  entry: AnyEntry,
  shape: Record<string, z.ZodType>,
  json: JsonSchema,
  prefix: string,
): Map<string, FieldInfo> {
  const properties = isRecord(json["properties"]) ? json["properties"] : {};
  const required = Array.isArray(json["required"]) ? (json["required"] as string[]) : [];
  const found = new Map<string, FieldInfo>();
  for (const [name, schema] of Object.entries(shape)) {
    const fieldJson = (properties[name] ?? {}) as JsonSchema;
    const items = isRecord(fieldJson["items"]) ? fieldJson["items"] : undefined;
    const itemScalar =
      fieldJson["type"] === "array" && items !== undefined ? scalarOf(items) : undefined;
    found.set(name, {
      name,
      path: `${prefix}${name}`,
      schema,
      json: fieldJson,
      required: required.includes(name),
      description: descriptionOf(schema) ?? "",
      userOnly: entry.agent?.hidden?.includes(`${prefix}${name}`) === true,
      scalar: scalarOf(fieldJson) ?? textFormOf(fieldJson),
      repeatable: itemScalar,
      values: valuesOf(itemScalar === undefined ? fieldJson : (items ?? {})),
    });
  }
  return found;
}

/** The fields a face can name: the input's top-level fields, then its `item`'s fields. */
export function faceFields(entry: AnyEntry, face: CliFace): Map<string, FieldInfo> {
  const json = inputJsonSchema(entry);
  const fields = infos(entry, entry.input.shape, json, "");
  if (face.item === undefined) return fields;
  const item = fields.get(face.item);
  const element = item === undefined ? undefined : defOf(coreOf(item.schema))["element"];
  const elementShape = element === undefined ? undefined : shapeOf(element as z.ZodType);
  const itemJson = item?.json["items"];
  if (item === undefined || elementShape === undefined || !isRecord(itemJson)) return fields;
  // An item's field is required only when the item is: `ttasks prefs get` gives no `set`.
  for (const [name, info] of infos(entry, elementShape, itemJson, `${face.item}[].`)) {
    if (!fields.has(name)) fields.set(name, { ...info, required: item.required && info.required });
  }
  return fields;
}

/** The fields of an object field, for `key=value` arguments. */
export function keyValueFields(entry: AnyEntry, field: string): Map<string, FieldInfo> | undefined {
  const schema = (entry.input.shape as Record<string, z.ZodType>)[field];
  const shape = schema === undefined ? undefined : shapeOf(schema);
  const json = (inputJsonSchema(entry)["properties"] as Record<string, JsonSchema> | undefined)?.[
    field
  ];
  if (shape === undefined || json === undefined) return undefined;
  return infos(entry, shape, json, `${field}.`);
}

/** `waiting_on` becomes `waiting-on`. */
export function kebab(name: string): string {
  return name.replaceAll("_", "-");
}
