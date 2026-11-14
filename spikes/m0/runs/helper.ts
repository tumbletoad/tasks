// Builds the console-ctrl helper (console-ctrl.cs) with the .NET Framework's own C# compiler,
// which every Windows 11 and Windows Server 2025 machine has. Lab code (M0.11), never shipped.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "console-ctrl.cs");

/** The csc.exe of .NET Framework 4, or undefined when it is missing (or not on Windows). */
export function findCsc(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const windir = process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows";
  const csc = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  return existsSync(csc) ? csc : undefined;
}

/** Compiles the helper into `outDir` and returns its path. */
export function buildHelper(outDir: string): string {
  const csc = findCsc();
  if (csc === undefined) throw new Error("csc.exe of .NET Framework 4 not found");
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, "console-ctrl.exe");
  const r = spawnSync(csc, ["/nologo", "/optimize+", "/target:exe", `/out:${exe}`, SOURCE], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (r.status !== 0 || !existsSync(exe)) {
    throw new Error(`csc failed (${String(r.status)}): ${r.stdout.slice(0, 2000)}`);
  }
  return exe;
}
