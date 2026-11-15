// Machine preferences (A1 3.16): the registry's keys with `scope: "machine"`, which live in this
// machine's machine.toml under `[preferences]` and never travel. Reading is machine-toml.ts's;
// this module gives every machine key its value as readers see it, and sets or resets one.
//
// Who may set: a machine preference is the user's (A2 3.2.4: every edit of machine.toml is a
// user-only operation). The caller, the UI session or an interactive CLI, checks that.
import {
  fitsShape,
  PREFERENCES,
  preferenceSpec,
  type PreferenceRead,
  type PrefValue,
} from "@tasks/contracts";
import { isAbsoluteFor } from "@tasks/launch";
import { commitEdit, prepareEdit, type EditResult, type EditValue } from "./edit.ts";
import type { MachineConfig } from "./machine-toml.ts";

/** Every machine preference the registry declares, in its order: set, else its default. */
export function readMachinePreferences(config: MachineConfig): PreferenceRead[] {
  return PREFERENCES.filter((spec) => spec.scope === "machine").map((spec) => {
    const value = config.preferences.get(spec.key);
    return value === undefined
      ? { key: spec.key, value: spec.default, state: "default" }
      : { key: spec.key, value, state: "set" };
  });
}

/** A value machine.toml can hold: what the edit module writes. */
function editValue(value: PrefValue): EditValue | undefined {
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? value : undefined;
  }
  const entries = Object.entries(value as Record<string, PrefValue>);
  return entries.every(([, item]) => typeof item === "string")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}

/**
 * Sets a machine preference in `<config>/machine.toml`, or resets it to its default with null by
 * removing its line. One splice, every other byte kept (edit.ts). A key that is not a machine
 * preference, or a value outside its shape or not absolute here, is `invalid_value` and nothing is
 * written. A reset of a key that is not set writes nothing.
 */
export function setMachinePreference(
  configDir: string,
  key: string,
  value: PrefValue | null,
  platform: NodeJS.Platform = process.platform,
): EditResult {
  const spec = preferenceSpec(key);
  if (spec?.scope !== "machine") return { ok: false, reason: "invalid_value" };
  let written: EditValue | undefined;
  if (value !== null) {
    const fits =
      fitsShape(spec.shape, value) &&
      (spec.shape.type !== "path" || isAbsoluteFor(platform, value as string));
    written = fits ? editValue(value) : undefined;
    if (written === undefined) return { ok: false, reason: "invalid_value" };
  }
  const prepared = prepareEdit(configDir, [
    written === undefined
      ? { op: "unset", table: ["preferences"], key }
      : { op: "set", table: ["preferences"], key, value: written },
  ]);
  if (!prepared.ok) return prepared;
  const { before, text } = prepared.edit;
  // Nothing changes: no write, and no file made where there was none.
  if (before === undefined ? text === "" : before.equals(Buffer.from(text, "utf8"))) {
    return { ok: true, text };
  }
  return commitEdit(prepared.edit);
}
