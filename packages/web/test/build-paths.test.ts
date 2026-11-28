// The built page carries no path of the machine that built it, whatever NODE_ENV the
// build runs with. A development build's JSX names every component's source file by its absolute
// path, so a build under Vitest (`test`) or with `development` would ship the build machine's
// folders, its user name included. Each build goes to a temporary folder of this file's own.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { asProduction, buildWeb, type BuiltWeb } from "../build.ts";

const WINDOWS = process.platform === "win32";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "ttasks-web-paths-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Builds with NODE_ENV as given (undefined: unset), and gives the caller's value back. */
async function buildWith(nodeEnv: string | undefined, name: string): Promise<BuiltWeb> {
  const before = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  try {
    const built = await buildWeb(join(work, name));
    // The build hands NODE_ENV back as it found it.
    expect(process.env.NODE_ENV).toBe(nodeEnv);
    return built;
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}

/**
 * Every spelling of `path` a bundle could hold: either slash, backslashes escaped, and characters
 * past ASCII as they are or as `\u` escapes.
 */
function spellings(path: string): string[] {
  const forward = path.replaceAll("\\", "/");
  const back = path.replaceAll("/", "\\");
  const escape = (p: string) =>
    p.replace(/\P{ASCII}/gu, (c) =>
      Array.from(
        { length: c.length },
        (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`,
      ).join(""),
    );
  return [forward, back, back.replaceAll("\\", "\\\\")]
    .flatMap((p) => [p, escape(p)])
    .map((p) => (WINDOWS ? p.toLowerCase() : p));
}

/**
 * The machine's own folders: the repository, the home folder and the output. A folder of fewer
 * than two segments (a home folder of `/`, say) names nothing in particular and is left out.
 */
function machinePaths(out: string): string[] {
  const repository = join(import.meta.dirname, "..", "..", "..");
  return [repository, homedir(), out]
    .filter((p) => p.split(/[\\/]/).filter((s) => s !== "").length >= 2)
    .flatMap(spellings);
}

describe("[A5.3.24.web.build-paths] the built page holds no absolute path of the build machine", () => {
  test("builds that overlap run one at a time, each in production, and give NODE_ENV back", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const seen: string[] = [];
      let endFirst = (): void => undefined;
      const first = asProduction(async () => {
        seen.push(`first ${String(process.env.NODE_ENV)}`);
        await new Promise<void>((done) => {
          endFirst = done;
        });
        seen.push("first ends");
        throw new Error("the first build fails");
      });
      const second = asProduction(async () => {
        seen.push(`second ${String(process.env.NODE_ENV)}`);
        await Promise.resolve();
        seen.push("second ends");
        return "built";
      });
      // Let the second have its chance to start before the first ends.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(seen).toEqual(["first production"]);
      endFirst();
      await expect(first).rejects.toThrow("the first build fails");
      await expect(second).resolves.toBe("built");
      expect(seen).toEqual(["first production", "first ends", "second production", "second ends"]);
      expect(process.env.NODE_ENV).toBe("test");
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  for (const nodeEnv of ["test", "development", undefined]) {
    test(`with NODE_ENV ${nodeEnv ?? "unset"}`, async () => {
      const built = await buildWith(nodeEnv, nodeEnv ?? "unset");
      const paths = machinePaths(built.out);
      for (const file of built.files) {
        // As UTF-8, which the bundle is written in, so a path past ASCII is found too.
        const text = readFileSync(join(built.out, ...file.split("/")), "utf8");
        const seen = WINDOWS ? text.toLowerCase() : text;
        expect([file, paths.filter((p) => seen.includes(p))]).toEqual([file, []]);
        // React's development JSX, which is what carries the source paths.
        expect([file, /jsxDEV/i.test(text)]).toEqual([file, false]);
      }
    }, 240_000);
  }
});
