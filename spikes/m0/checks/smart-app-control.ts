// Lab row R12 (A7 3.7, A2 M0-S13 and 3.12.7): the Smart App Control state, read only.
//
//   node spikes/m0/checks/smart-app-control.ts --out <folder>
//
// Reads HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy VerifiedAndReputablePolicyState:
// 0 is Off, 1 is On (enforced), 2 is Evaluation. A missing value means the feature is not present.
// Anywhere but Windows the row does not apply, and the result says so.
import { resolve } from "node:path";
import process from "node:process";
import { machineFacts, options, powershellJson, writeResult } from "./common.ts";

export type SacState = "off" | "on" | "evaluation" | "absent" | "unknown";

export function sacState(value: number | null): SacState {
  if (value === null) return "absent";
  return value === 0 ? "off" : value === 1 ? "on" : value === 2 ? "evaluation" : "unknown";
}

function main(argv: readonly string[]): number {
  const o = options(argv, ["out"]);
  if (o.out === undefined) throw new Error("pass --out <folder>");
  let value: number | null = null;
  let state: SacState | "not applicable" = "not applicable";
  if (process.platform === "win32") {
    const read = powershellJson(`
$k = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -ErrorAction SilentlyContinue
if ($k -and $k.PSObject.Properties['VerifiedAndReputablePolicyState']) { [int]$k.VerifiedAndReputablePolicyState } else { $null }`);
    value = typeof read === "number" ? read : null;
    state = sacState(value);
  }
  console.log(
    `Smart App Control: ${state}${value === null ? "" : ` (VerifiedAndReputablePolicyState ${String(value)})`}`,
  );
  const file = writeResult(String(o.out), "r12-smart-app-control.json", {
    row: "R12",
    at: new Date().toISOString(),
    machine: machineFacts(),
    value,
    state,
  });
  console.log(`result: ${file}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
