// Windows' "Default terminal application" (A4 3.6.1): Settings > System > For developers >
// Terminal, stored per account as two REG_SZ GUIDs under `HKCU\Console\%%Startup` (the key's name
// holds the two percent signs). Microsoft documents the values in "Group Policy for Windows
// Terminal" (learn.microsoft.com/windows/terminal/group-policy, "Default terminal application")
// and in the support article "Command Prompt and Windows PowerShell":
//
//   Let Windows decide   DelegationConsole and DelegationTerminal {00000000-0000-0000-0000-000000000000}
//                        (or absent): Windows Terminal when it is installed, else the console
//   Windows Console Host both {B23D10C0-E52E-411E-9D5B-C09FDF709C7D}
//   Windows Terminal     DelegationConsole {2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69},
//                        DelegationTerminal {E12CFF52-A866-4C77-9A90-F570A7AA2C6B}
//   Terminal Preview     DelegationConsole {06EC847C-C0A5-46B8-92CB-7C92F6E35CD5},
//                        DelegationTerminal {86633F1F-6454-40EC-89CE-DA4EBA977EE2}
//
// Read with reg.exe by its full path, never a PowerShell cmdlet (a cmdlet makes Windows PowerShell
// search its module path, which takes seconds on a slow machine), with a short deadline: no answer
// is no setting. Nothing read here is logged.
import { win32 } from "node:path";
import { captureOutput, type Capture } from "../environment/capture.ts";

/** The two values as read: the GUIDs, uppercased, or undefined for a value that is not there. */
export interface WindowsDelegation {
  readonly console: string | undefined;
  readonly terminal: string | undefined;
}

/** What the setting means for a launch: Windows Terminal, the console, Windows decides, another. */
export type DelegationChoice = "wt" | "console" | "auto" | "other";

export const STARTUP_KEY = "HKCU\\Console\\%%Startup";

const AUTO = "{00000000-0000-0000-0000-000000000000}";
const CONHOST = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";
/** Windows Terminal and Windows Terminal Preview: each opens through the `wt.exe` alias. */
const WINDOWS_TERMINAL = new Set([
  "{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}",
  "{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}",
  "{06EC847C-C0A5-46B8-92CB-7C92F6E35CD5}",
  "{86633F1F-6454-40EC-89CE-DA4EBA977EE2}",
]);

/** How long reg.exe may take: it answers in well under a second. */
export const DELEGATION_READ_MS = 3_000;

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;

/**
 * The meaning of the values (head of this file). DelegationTerminal names the terminal;
 * DelegationConsole decides only when the other is absent. A value that is not a GUID is no
 * setting.
 */
export function delegationChoice(values: WindowsDelegation | undefined): DelegationChoice {
  const value = values?.terminal ?? values?.console;
  if (value === undefined || value === AUTO) return "auto";
  if (value === CONHOST) return "console";
  if (WINDOWS_TERMINAL.has(value)) return "wt";
  return "other";
}

/**
 * `reg query HKCU\Console\%%Startup`'s output: lines of `<name>  REG_SZ  <data>`. Value names and
 * the type are never translated. Only the two delegation values, and only GUIDs, are kept.
 */
export function parseDelegation(text: string): WindowsDelegation {
  let console: string | undefined;
  let terminal: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s+(DelegationConsole|DelegationTerminal)\s+REG_SZ\s+(\S+)\s*$/i.exec(raw);
    if (match === null) continue;
    const value = (match[2] ?? "").toUpperCase();
    if (!GUID.test(value)) continue;
    if (match[1]?.toLowerCase() === "delegationconsole") console = value;
    else terminal = value;
  }
  return { console, terminal };
}

/** reg.exe by its full path: present on every Windows. */
export function regPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
  const base = root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows";
  return win32.join(base, "System32", "reg.exe");
}

/**
 * The account's setting, read now; undefined when reg.exe did not answer in time or failed. A
 * missing key (reg.exe exits 1) is "Let Windows decide", as Windows reads it.
 */
export async function readDelegation(options: {
  readonly reg: string;
  readonly env: Readonly<Record<string, string>>;
  readonly capture?: Capture;
}): Promise<WindowsDelegation | undefined> {
  const capture = options.capture ?? captureOutput;
  const result = await capture({
    argv: [options.reg, "query", STARTUP_KEY],
    env: options.env,
    timeoutMs: DELEGATION_READ_MS,
    maxBytes: 64 * 1024,
  }).catch(() => undefined);
  if (result?.kind !== "done") return undefined;
  if (result.code === 1) return { console: undefined, terminal: undefined };
  if (result.code !== 0) return undefined;
  return parseDelegation(result.output.toString("latin1"));
}
