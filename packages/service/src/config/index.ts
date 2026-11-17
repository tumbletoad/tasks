// Machine-local configuration (A2 3.2.4): reading machine.toml strictly, editing it without
// touching other bytes.
export {
  checkMachineConfig,
  DEFAULT_CONFIG,
  fatalProblems,
  loadMachineConfig,
  LOG_LEVELS,
  MACHINE_TOML,
  parseMachineConfig,
  RESERVED_SECTIONS,
  SECTIONS,
  sectionOf,
  type LoadedMachineConfig,
  type MachineConfig,
  type Section,
  type SpaceRegistration,
  type UnsafeConfig,
  type UnsafePart,
} from "./machine-toml.ts";
export {
  applyEdits,
  commitEdit,
  editMachineToml,
  prepareEdit,
  keyText,
  valueText,
  type Edit,
  type EditRefusal,
  type EditResult,
  type EditValue,
  type Entries,
  type PreparedEdit,
} from "./edit.ts";
export { configRefusal, unsafeConfigMessage } from "./messages.ts";
export { readMachinePreferences, setMachinePreference } from "./preferences.ts";
export { decodeConfig, MAX_CONFIG_BYTES, parseToml } from "./toml.ts";
