// Generated files (A7 3.3: `pnpm gen` writes them, `pnpm verify` checks they are fresh).
//
// A generator owns one folder and renders every file it must hold. The check compares the folder
// with a fresh render: a missing, changed or extra file fails. Generators register in `generators`
// below.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { CLI_NAME, MCP_SERVER_KEY, PRODUCT_ID } from "../packages/brand/src/index.ts";
import { contractsGenerators } from "../packages/contracts/src/gen/index.ts";
import { bridgeOfflineGenerator } from "./bridge-offline.ts";

export interface Generator {
  /** Shown in messages. */
  readonly name: string;
  /** Output folder relative to the repository root. The generator owns every file in it. */
  readonly dir: string;
  /** Every file the folder must hold, keyed by path relative to `dir` with "/" separators. */
  render(): Promise<ReadonlyMap<string, string>>;
}

export const generators: readonly Generator[] = [
  // packages/contracts/generated/ and docs/agents/ (A3 3.2.2). The names come from the brand, so
  // contracts depend on nothing in the repository (A7 3.2).
  ...contractsGenerators({ cli: CLI_NAME, mcpServerKey: MCP_SERVER_KEY, productId: PRODUCT_ID }),
  // packages/bridge/lib/mcp-offline.json (A2 3.7.3): the bridge's offline answers, captured from
  // the service's MCP endpoint, whose tool list is contracts' generated one.
  bridgeOfflineGenerator(),
];

async function listFiles(dir: string): Promise<string[]> {
  try {
    const found = await readdir(dir, { recursive: true, withFileTypes: true });
    return found
      .filter((d) => d.isFile())
      .map((d) => relative(dir, join(d.parentPath, d.name)).replaceAll("\\", "/"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Returns one message per stale file. Empty when every generator's folder is fresh. */
export async function checkGenerated(
  root: string,
  list: readonly Generator[] = generators,
): Promise<string[]> {
  const problems: string[] = [];
  for (const g of list) {
    const dir = join(root, g.dir);
    const expected = await g.render();
    for (const [path, content] of expected) {
      const actual = await readIfExists(join(dir, path));
      if (actual === undefined) problems.push(`${g.name}: ${g.dir}/${path} is missing`);
      else if (actual !== content) problems.push(`${g.name}: ${g.dir}/${path} is out of date`);
    }
    for (const path of await listFiles(dir)) {
      if (!expected.has(path)) problems.push(`${g.name}: ${g.dir}/${path} is not generated`);
    }
  }
  return problems;
}

/** Writes every generator's folder and removes files it no longer renders. */
export async function writeGenerated(
  root: string,
  list: readonly Generator[] = generators,
): Promise<void> {
  for (const g of list) {
    const dir = join(root, g.dir);
    const expected = await g.render();
    for (const path of await listFiles(dir)) {
      if (!expected.has(path)) await rm(join(dir, path));
    }
    for (const [path, content] of expected) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      if ((await readIfExists(target)) !== content) await writeFile(target, content);
    }
  }
}
