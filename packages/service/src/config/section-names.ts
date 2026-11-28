// The top-level keys of machine.toml, by owner (A2 3.2.4). A closed list: logs name these. Kept
// apart from machine-toml.ts so the log's catalogue can import it without a cycle.
export const SECTIONS = [
  "service",
  "http",
  "ui",
  "updates",
  "log",
  "spaces",
  "terminal",
  "instance",
  "approvals",
  // Background runs' guidelines: how many at once, and for how long.
  "runs",
  // A3 3.12: `[setup.managed] paths`, files setup treats as managed by another source.
  "setup",
  // A1 3.16: this machine's preferences, by their whole name.
  "preferences",
  "custom_target",
  "override",
  "remote",
  "security",
] as const;
export type Section = (typeof SECTIONS)[number];
