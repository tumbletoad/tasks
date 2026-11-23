// Builds ttasks.exe and ttasksw.exe from launcher.c, and ttasks-run.exe from run.c, with MSVC.
// Windows only.
//
//   node packages/launcher-win/src/build.ts [--out <dir>] [--test-hooks]
//
// A release build is the default and writes into packages/launcher-win/dist/. --test-hooks
// defines TTASKS_TEST_HOOKS for this package's tests (README.md, "Test builds"): never ship it.
//
// cl.exe and link.exe are found through vswhere, the Windows SDK by its default folder. INCLUDE, LIB
// and PATH are passed to them directly, so no vcvars batch file and no shell runs, and every tool gets
// an argument array. The caller's compiler and linker variables never reach the tools, and a
// release build is checked for test hooks before it counts as built.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** The one C source of both launchers. */
export const launcherSource = join(here, "launcher.c");
/** The source of ttasks-run.exe, which holds a background run's job object. */
export const runHelperSource = join(here, "run.c");
/** Where a build writes by default (git-ignored). */
export const defaultOut = resolve(here, "..", "dist");

export interface Msvc {
  cl: string;
  link: string;
  env: Record<string, string>;
}

export interface Launchers {
  ttasks: string;
  ttasksw: string;
}

export interface BuildOptions {
  /** Defines TTASKS_TEST_HOOKS. Only this package's tests set it. */
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
 * /external:env, which this build never passes). CL=/DTTASKS_TEST_HOOKS would put the test hooks
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
  return { cl, link: join(dirname(cl), "link.exe"), env };
}

export interface NativeSource {
  /** The C file. */
  source: string;
  /** The program or DLL to write. */
  out: string;
  /** Compiler options, besides /c, the object file and the source. */
  compile: readonly string[];
  /** Linker options, besides the output and the object file. */
  link: readonly string[];
}

/**
 * Compiles and links one C file as two steps, so a failure names its step, its exit status and
 * what the tool printed. A tool that ends without a word still leaves its status: 0xC0000142
 * says the process could not start, another 0xC0000… code what ended it.
 */
export function compileC(msvc: Msvc, { source, out, compile, link }: NativeSource): string {
  const objDir = `${out}.obj.d`;
  mkdirSync(objDir, { recursive: true });
  const obj = join(objDir, "main.obj");
  try {
    runTool(msvc, "compile", msvc.cl, ["/nologo", "/c", ...compile, `/Fo${obj}`, source], out);
    runTool(msvc, "link", msvc.link, ["/nologo", ...link, `/OUT:${out}`, obj], out);
  } finally {
    rmSync(objDir, { recursive: true, force: true });
  }
  return out;
}

function runTool(msvc: Msvc, step: string, tool: string, args: string[], out: string): void {
  const result = spawnSync(tool, args, {
    cwd: dirname(out),
    env: msvc.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`the ${step} step for ${out} did not start`, { cause: result.error });
  }
  if (result.status === 0) return;
  const ended =
    result.status === null
      ? `was ended by ${String(result.signal)}`
      : `exited with ${String(result.status)} (0x${(result.status >>> 0).toString(16).toUpperCase()})`;
  const said = `${result.stdout}${result.stderr}`.trim();
  throw new Error(
    `the ${step} step for ${out} failed: ${basename(tool)} ${ended}\n${said === "" ? "(no output)" : said}`,
  );
}

interface Program {
  name: "ttasks" | "ttasksw" | "ttasks-run";
  source: string;
  gui: boolean;
  testHooks: boolean;
}

/**
 * Compiles one program. Hardening: buffer security checks, Control Flow Guard, CET shadow-stack
 * compatibility, ASLR with high entropy, DEP, the static C runtime (no runtime DLL to plant) and
 * imported DLLs loaded from System32 only. /Brepro makes the output reproducible.
 */
function compile(outDir: string, { name, source, gui, testHooks }: Program, msvc: Msvc) {
  return compileC(msvc, {
    source,
    out: join(outDir, `${name}.exe`),
    compile: [
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
      ...(gui ? ["/DTTASKS_GUI"] : []),
      ...(testHooks ? ["/DTTASKS_TEST_HOOKS"] : []),
    ],
    link: [
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
  });
}

/** Every test hook's name starts with this (README.md, "Test builds"). */
const HOOK_PREFIX = "TTASKS_TEST_";

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
 * Builds ttasks.exe (console) and ttasksw.exe (GUI) into outDir and returns their paths. A release
 * build that contains a test hook is deleted and the build fails.
 */
export function buildLaunchers(outDir: string = defaultOut, options: BuildOptions = {}): Launchers {
  const msvc = options.msvc ?? findMsvc();
  const testHooks = options.testHooks ?? false;
  mkdirSync(outDir, { recursive: true });
  const built: Launchers = {
    ttasks: compile(
      outDir,
      { name: "ttasks", source: launcherSource, gui: false, testHooks },
      msvc,
    ),
    ttasksw: compile(
      outDir,
      { name: "ttasksw", source: launcherSource, gui: true, testHooks },
      msvc,
    ),
  };
  if (!testHooks) {
    try {
      assertReleaseBinary(built.ttasks);
      assertReleaseBinary(built.ttasksw);
    } catch (error) {
      rmSync(built.ttasks, { force: true });
      rmSync(built.ttasksw, { force: true });
      throw error;
    }
  }
  return built;
}

/**
 * Builds `ttasks-run.exe`, the holder of a background run's job object (src/run.c), into outDir and
 * returns its path. It has no test hooks: a test build and a release build are the same.
 */
export function buildRunHelper(outDir: string = defaultOut, msvc: Msvc = findMsvc()): string {
  mkdirSync(outDir, { recursive: true });
  const exe = compile(
    outDir,
    { name: "ttasks-run", source: runHelperSource, gui: false, testHooks: false },
    msvc,
  );
  assertReleaseBinary(exe);
  return exe;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "test-hooks": { type: "boolean", default: false },
    },
  });
  const out = resolve(values.out ?? defaultOut);
  const built = buildLaunchers(out, { testHooks: values["test-hooks"] });
  console.log(built.ttasks);
  console.log(built.ttasksw);
  console.log(buildRunHelper(out));
}
