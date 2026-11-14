// Lab row R11 (A7 3.7, A6 3.4 and M0 item 5): the OS machine identifier and the user's account
// identifier, the two inputs of the host fingerprint, are readable without admin rights.
//
//   node spikes/m0/checks/machine-id.ts --out <folder>
//
// Linux: /etc/machine-id (then /var/lib/dbus/machine-id) and the account's UID. Windows:
// HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid and the account's SID. macOS: IOPlatformUUID.
// Nothing records an identifier. The result holds whether each is readable, its length and its
// format class. The console shows an 8-character SHA-256 prefix, so two runs can be compared by
// eye, and the result file does not hold even that.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { isElevated, machineFacts, options, powershellJson, writeResult } from "./common.ts";

export type FormatClass = "hex32" | "guid" | "uuid-upper" | "sid" | "uid" | "empty" | "other";

export function formatClass(value: string): FormatClass {
  if (value === "") return "empty";
  if (/^[0-9a-f]{32}$/.test(value)) return "hex32";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return "guid";
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value))
    return "uuid-upper";
  if (/^S-1-\d+(-\d+)+$/.test(value)) return "sid";
  if (/^\d+$/.test(value)) return "uid";
  return "other";
}

export interface Probe {
  source: string;
  readable: boolean;
  length: number;
  format: FormatClass;
  error?: string;
}

/** Describes a value without keeping it. The caller gets the 8-character hash prefix separately. */
export function describe(source: string, read: () => string): { probe: Probe; prefix: string } {
  try {
    const value = read().trim();
    return {
      probe: { source, readable: value !== "", length: value.length, format: formatClass(value) },
      prefix: createHash("sha256").update(value).digest("hex").slice(0, 8),
    };
  } catch (error) {
    const code =
      (error as { code?: string }).code ?? (error instanceof Error ? error.message : "error");
    return {
      probe: { source, readable: false, length: 0, format: "empty", error: code },
      prefix: "",
    };
  }
}

function probes(): { probe: Probe; prefix: string }[] {
  if (process.platform === "win32") {
    let ids: { machine: string; user: string } | undefined;
    const get = () => {
      ids ??= powershellJson(`@{
  machine = [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
  user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}`) as { machine: string; user: string };
      return ids;
    };
    return [
      describe("HKLM\\SOFTWARE\\Microsoft\\Cryptography MachineGuid", () => get().machine),
      describe("account SID", () => get().user),
    ];
  }
  if (process.platform === "darwin") {
    return [
      describe("IOPlatformUUID", () => {
        const r = spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
          encoding: "utf8",
        });
        return /"IOPlatformUUID" = "([^"]+)"/.exec(r.stdout)?.[1] ?? "";
      }),
      describe("account UID", () => String(process.getuid?.() ?? "")),
    ];
  }
  const etc = describe("/etc/machine-id", () => readFileSync("/etc/machine-id", "utf8"));
  const list = [etc];
  if (!etc.probe.readable)
    list.push(
      describe("/var/lib/dbus/machine-id", () => readFileSync("/var/lib/dbus/machine-id", "utf8")),
    );
  list.push(describe("account UID", () => String(process.getuid?.() ?? "")));
  return list;
}

function main(argv: readonly string[]): number {
  const o = options(argv, ["out"]);
  if (o.out === undefined) throw new Error("pass --out <folder>");
  const found = probes();
  const elevated = isElevated();
  for (const f of found) {
    console.log(
      `${f.probe.source}: ${f.probe.readable ? "readable" : `NOT readable (${f.probe.error ?? "empty"})`}, ` +
        `length ${String(f.probe.length)}, format ${f.probe.format}, sha256 prefix ${f.prefix || "-"}`,
    );
  }
  const ok = !elevated && found.every((f) => f.probe.readable);
  console.log(`elevated: ${String(elevated)}`);
  console.log(
    ok ? "machine identifier readable without admin rights" : "machine identifier check FAILED",
  );
  const file = writeResult(String(o.out), "r11-machine-id.json", {
    row: "R11",
    at: new Date().toISOString(),
    machine: machineFacts(),
    elevated,
    ok,
    probes: found.map((f) => f.probe),
  });
  console.log(`result: ${file}`);
  return ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
