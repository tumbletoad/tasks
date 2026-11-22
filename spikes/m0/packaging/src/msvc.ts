// Builds ttasks.exe and ttasksw.exe with MSVC (A2 3.12.3), on the Windows runner and on a desktop
// with the Visual Studio Build Tools. It finds cl.exe through vswhere and the Windows SDK by its
// default folder, and passes INCLUDE, LIB and PATH to cl.exe itself, so no vcvars .bat file runs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launcherSource } from "./paths.ts";

export interface Msvc {
  cl: string;
  env: Record<string, string>;
}

function programFilesX86(): string {
  return process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
}

function versionKey(v: string): number[] {
  return v.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function newestVersion(versions: string[]): string | undefined {
  return [...versions].sort((a, b) => {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  })[versions.length - 1];
}

/** Finds the newest Visual Studio with the x64 C++ tools and the newest Windows 10/11 SDK. */
export function findMsvc(): Msvc {
  if (process.platform !== "win32") throw new Error("the Windows launchers build on Windows only");
  const vswhere = join(programFilesX86(), "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) throw new Error(`vswhere.exe not found at ${vswhere}`);
  const found = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const vs = found.stdout.trim().split(/\r?\n/)[0] ?? "";
  if (found.status !== 0 || vs === "") throw new Error("no Visual Studio with the C++ x64 tools");
  const toolsVersion = readFileSync(
    join(vs, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt"),
    "utf8",
  ).trim();
  const tools = join(vs, "VC", "Tools", "MSVC", toolsVersion);
  const cl = join(tools, "bin", "Hostx64", "x64", "cl.exe");
  if (!existsSync(cl)) throw new Error(`cl.exe not found at ${cl}`);

  const kits = join(programFilesX86(), "Windows Kits", "10");
  const sdk = newestVersion(
    existsSync(join(kits, "Include"))
      ? readdirSync(join(kits, "Include")).filter(
          (v) =>
            existsSync(join(kits, "Include", v, "um", "windows.h")) &&
            existsSync(join(kits, "Lib", v, "um", "x64", "kernel32.lib")),
        )
      : [],
  );
  if (sdk === undefined) throw new Error(`no Windows SDK found under ${kits}`);

  const include = [
    join(tools, "include"),
    join(kits, "Include", sdk, "ucrt"),
    join(kits, "Include", sdk, "um"),
    join(kits, "Include", sdk, "shared"),
  ];
  const lib = [
    join(tools, "lib", "x64"),
    join(kits, "Lib", sdk, "ucrt", "x64"),
    join(kits, "Lib", sdk, "um", "x64"),
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
  env[pathKey] = [
    join(tools, "bin", "Hostx64", "x64"),
    join(kits, "bin", sdk, "x64"),
    env[pathKey] ?? "",
  ].join(";");
  env["INCLUDE"] = include.join(";");
  env["LIB"] = lib.join(";");
  return { cl, env };
}

export interface Launchers {
  ttasks: string;
  ttasksw: string;
}

export interface CompileOptions {
  /** GUI subsystem (ttasksw.exe) instead of console. */
  gui?: boolean;
  /** Extra preprocessor names, defined without a value. */
  defines?: readonly string[];
}

/** Compiles one C source into `<outDir>\<name>.exe` with the launchers' flags. */
export function compileExe(
  source: string,
  outDir: string,
  name: string,
  options: CompileOptions = {},
  msvc: Msvc = findMsvc(),
): string {
  const gui = options.gui ?? false;
  mkdirSync(outDir, { recursive: true });
  const objDir = join(outDir, `${name}.obj.d`);
  mkdirSync(objDir, { recursive: true });
  const exe = join(outDir, `${name}.exe`);
  const result = spawnSync(
    msvc.cl,
    [
      "/nologo",
      "/W4",
      "/WX",
      "/O1",
      "/MT",
      "/GS",
      "/guard:cf",
      "/utf-8",
      "/Brepro",
      "/DUNICODE",
      "/D_UNICODE",
      ...(gui ? ["/DTTASKS_GUI"] : []),
      ...(options.defines ?? []).map((d) => `/D${d}`),
      `/Fo${objDir}\\`,
      `/Fe${exe}`,
      source,
      "/link",
      "/Brepro",
      "/guard:cf",
      "/DYNAMICBASE",
      "/NXCOMPAT",
      ...(gui ? ["/SUBSYSTEM:WINDOWS", "/ENTRY:wmainCRTStartup"] : ["/SUBSYSTEM:CONSOLE"]),
    ],
    { env: msvc.env, encoding: "utf8", windowsHide: true },
  );
  rmSync(objDir, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`cl.exe failed for ${name}.exe:\n${result.stdout}${result.stderr}`);
  }
  return exe;
}

/**
 * Compiles both launchers into `outDir`. Returns their paths. `defines` is for test builds only
 * (TTASKS_TEST_HOOKS): release builds never pass any.
 */
export function compileLaunchers(
  outDir: string,
  msvc: Msvc = findMsvc(),
  defines: readonly string[] = [],
): Launchers {
  return {
    ttasks: compileExe(launcherSource, outDir, "ttasks", { defines }, msvc),
    ttasksw: compileExe(launcherSource, outDir, "ttasksw", { gui: true, defines }, msvc),
  };
}
