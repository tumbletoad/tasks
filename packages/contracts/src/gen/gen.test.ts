// The generated files: fresh, and byte-stable on every OS. `pnpm verify`
// also compares both generated folders with a fresh render, with the brand's names.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registry } from "../registry.ts";
import { renderArtefacts } from "./artefacts.ts";
import { renderDocs } from "./docs.ts";
import { contractsGenerators } from "./index.ts";

const generatedDir = fileURLToPath(new URL("../../generated/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const names = { cli: "acme", mcpServerKey: "acme" };

function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [path, content] of renderArtefacts(registry)) files.set(`generated/${path}`, content);
  for (const [path, content] of renderDocs(registry, names)) files.set(`docs/${path}`, content);
  return files;
}

function unsortedKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => unsortedKeys(v, `${path}[${String(i)}]`));
  if (value === null || typeof value !== "object") return [];
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  const here = keys.join() === sorted.join() ? [] : [path];
  return [
    ...here,
    ...keys.flatMap((k) => unsortedKeys((value as Record<string, unknown>)[k], `${path}.${k}`)),
  ];
}

describe("[A3.5.registry.generated] the generated files are fresh and byte-stable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the checked-in packages/contracts/generated/ matches a fresh render", async () => {
    const expected = renderArtefacts(registry);
    const onDisk = (await readdir(generatedDir)).sort();
    expect(onDisk).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) {
      expect(await readFile(`${generatedDir}${file}`, "utf8"), file).toBe(content);
    }
  });

  test("the render does not depend on the clock or on the registry's order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T08:00:00Z"));
    const first = renderAll();
    vi.setSystemTime(new Date("2031-02-03T23:59:59Z"));
    expect(renderAll()).toEqual(first);
    const reversed = new Map([
      ...[...renderArtefacts([...registry].reverse())].map(
        ([p, c]) => [`generated/${p}`, c] as const,
      ),
      ...[...renderDocs([...registry].reverse(), names)].map(([p, c]) => [`docs/${p}`, c] as const),
    ]);
    expect(reversed).toEqual(first);
  });

  test("every file is LF only, ends with one newline and holds no machine path", () => {
    const machinePaths = [repoRoot, repoRoot.replaceAll("\\", "/"), homedir()].filter(
      (p) => p.length > 4,
    );
    for (const [file, content] of renderAll()) {
      expect(content.includes("\r"), `${file} has CR`).toBe(false);
      expect(content.endsWith("\n") && !content.endsWith("\n\n"), file).toBe(true);
      for (const path of machinePaths)
        expect(content.includes(path), `${file}: ${path}`).toBe(false);
    }
  });

  test("every JSON file has sorted keys at every level", () => {
    for (const [file, content] of renderArtefacts(registry)) {
      if (!file.endsWith(".json")) continue;
      expect(unsortedKeys(JSON.parse(content)), file).toEqual([]);
    }
  });

  test("the generators refuse a registry that fails the check", async () => {
    const status = registry[0];
    const mcp = { tool: "acme_status", title: "Status", description: "Use to see the status." };
    const [contracts] = contractsGenerators(names, [
      { ...status, faces: { ...status.faces, mcp } },
    ]);
    await expect(contracts?.render()).rejects.toThrow(
      /a tool name does not start with the MCP server key/,
    );
  });
});
