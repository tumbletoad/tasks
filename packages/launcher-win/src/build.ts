// Builds tasks.exe and tasksw.exe from launcher.c with MSVC (A2 3.12.3). Windows only.
//
//   node packages/launcher-win/src/build.ts [--out <dir>] [--test-hooks]
//
// A release build is the default and writes into packages/launcher-win/dist/. --test-hooks
// defines TASKS_TEST_HOOKS for this package's tests (README.md, "Test builds"): never ship it.
//
// cl.exe is found through vswhere, the Windows SDK by its default folder. INCLUDE, LIB and PATH
// are passed to cl.exe directly, so no vcvars batch file and no shell runs, and every tool gets
// an argument array. The caller's compiler and linker variables never reach the tools, and a
// release build is checked for test hooks before it counts as built.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** The one C source of both launchers. */
export const launcherSource = join(here, "launcher.c");
/** Where a build writes by default (git-ignored). */
export const defaultOut = resolve(here, "..", "dist");

export interface Msvc {
  cl: string;
  env: Record<string, string>;
}

export interface Launchers {
  tasks: string;
  tasksw: string;
}

export interface BuildOptions {
  /** Defines TASKS_TEST_HOOKS. Only this package's tests set it. */
  testHooks?: boolean;
  msvc?: Msvc;
}

function programFilesX86(): string {
  return process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
}

function compareVersions(a: string, b: string): number {
  const ka = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const kb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The variables cl.exe and link.exe read as options or search paths (Microsoft Learn, "CL
 * environment variables" and "LINK environment variables"; EXTERNAL_INCLUDE only with
 * /external:env, which this build never passes). CL=/DTASKS_TEST_HOOKS would put the test hooks
 * into a release build. None of them comes from the caller: INCLUDE and LIB are set below.
 */
const TOOL_VARIABLES = new Set([
  "CL",
  "_CL_",
  "LINK",
  "_LINK_",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "EXTERNAL_INCLUDE",
]);

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
      "-utf8",
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
  const sdks = existsSync(join(kits, "Include"))
    ? readdirSync(join(kits, "Include")).filter(
        (v) =>
          existsSync(join(kits, "Include", v, "um", "windows.h")) &&
          existsSync(join(kits, "Lib", v, "um", "x64", "kernel32.lib")),
      )
    : [];
  const sdk = sdks.sort(compareVersions).at(-1);
  if (sdk === undefined) throw new Error(`no Windows SDK found under ${kits}`);

  // Windows matches variable names without case, so every spelling of a tool variable goes.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !TOOL_VARIABLES.has(key.toUpperCase())) env[key] = value;
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
  env[pathKey] = [
    join(tools, "bin", "Hostx64", "x64"),
    join(kits, "bin", sdk, "x64"),
    env[pathKey] ?? "",
  ].join(";");
  env["INCLUDE"] = [
    join(tools, "include"),
    join(kits, "Include", sdk, "ucrt"),
    join(kits, "Include", sdk, "um"),
    join(kits, "Include", sdk, "shared"),
  ].join(";");
  env["LIB"] = [
    join(tools, "lib", "x64"),
    join(kits, "Lib", sdk, "ucrt", "x64"),
    join(kits, "Lib", sdk, "um", "x64"),
  ].join(";");
  return { cl, env };
}

/**
 * Compiles one launcher. Hardening: buffer security checks, Control Flow Guard, CET shadow-stack
 * compatibility, ASLR with high entropy, DEP, the static C runtime (no runtime DLL to plant) and
 * imported DLLs loaded from System32 only. /Brepro makes the output reproducible.
 */
function compile(outDir: string, name: "tasks" | "tasksw", testHooks: boolean, msvc: Msvc) {
  const gui = name === "tasksw";
  const objDir = join(outDir, `${name}.obj.d`);
  mkdirSync(objDir, { recursive: true });
  const exe = join(outDir, `${name}.exe`);
  const result = spawnSync(
    msvc.cl,
    [
      "/nologo",
      "/W4",
      "/WX",
      "/sdl",
      "/O1",
      "/MT",
      "/GS",
      "/guard:cf",
      "/utf-8",
      "/Brepro",
      "/DUNICODE",
      "/D_UNICODE",
      ...(gui ? ["/DTASKS_GUI"] : []),
      ...(testHooks ? ["/DTASKS_TEST_HOOKS"] : []),
      `/Fo${objDir}\\`,
      `/Fe${exe}`,
      launcherSource,
      "/link",
      "/Brepro",
      "/guard:cf",
      "/CETCOMPAT",
      "/DYNAMICBASE",
      "/HIGHENTROPYVA",
      "/NXCOMPAT",
      "/DEPENDENTLOADFLAG:0x800",
      "/INCREMENTAL:NO",
      "/MANIFEST:NO",
      ...(gui ? ["/SUBSYSTEM:WINDOWS", "/ENTRY:wmainCRTStartup"] : ["/SUBSYSTEM:CONSOLE"]),
    ],
    { cwd: outDir, env: msvc.env, encoding: "utf8", windowsHide: true },
  );
  rmSync(objDir, { recursive: true, force: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cl.exe failed for ${name}.exe:\n${result.stdout}${result.stderr}`);
  }
  return exe;
}

/** Every test hook's name starts with this (README.md, "Test builds"). */
const HOOK_PREFIX = "TASKS_TEST_";

/**
 * Throws unless exe is a release launcher: no test hook name, as UTF-16 (how launcher.c writes
 * its strings) or as single bytes. buildLaunchers runs it on every release build, and the
 * release build (M1.13) runs it on the binaries it ships.
 */
export function assertReleaseBinary(exe: string): void {
  const image = readFileSync(exe);
  for (const encoding of ["utf16le", "latin1"] as const) {
    if (image.includes(Buffer.from(HOOK_PREFIX, encoding))) {
      throw new Error(`${exe} contains test hooks (${HOOK_PREFIX}…): it is no release build`);
    }
  }
}

/**
 * Builds tasks.exe (console) and tasksw.exe (GUI) into outDir and returns their paths. A release
 * build that contains a test hook is deleted and the build fails.
 */
export function buildLaunchers(outDir: string = defaultOut, options: BuildOptions = {}): Launchers {
  const msvc = options.msvc ?? findMsvc();
  const testHooks = options.testHooks ?? false;
  mkdirSync(outDir, { recursive: true });
  const built: Launchers = {
    tasks: compile(outDir, "tasks", testHooks, msvc),
    tasksw: compile(outDir, "tasksw", testHooks, msvc),
  };
  if (!testHooks) {
    try {
      assertReleaseBinary(built.tasks);
      assertReleaseBinary(built.tasksw);
    } catch (error) {
      rmSync(built.tasks, { force: true });
      rmSync(built.tasksw, { force: true });
      throw error;
    }
  }
  return built;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "test-hooks": { type: "boolean", default: false },
    },
  });
  const built = buildLaunchers(resolve(values.out ?? defaultOut), {
    testHooks: values["test-hooks"],
  });
  console.log(built.tasks);
  console.log(built.tasksw);
}
