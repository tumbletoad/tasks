// `ttasks roots` is retired: it points to where tasks open now and changes nothing, so a person or a
// script that still calls it learns why, and machine.toml keeps every byte. No service is needed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configOf, tempRoot } from "@ttasks/service/test/harness";
import { runMain } from "./cli-harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("[A1.3.15.roots.retired] ttasks roots is a pointer and changes nothing", () => {
  test("list says where tasks open now; add fails and writes nothing; machine.toml keeps its bytes", async () => {
    const { root, cleanup } = tempRoot("rt");
    cleanups.push(cleanup);
    const home = join(root, "h");
    mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
    const file = join(configOf(home), "machine.toml");
    const text = '# Mira\'s machine\n[roots.work]\npath = "/home/mira/work"\n';
    writeFileSync(file, text, { mode: 0o600 });

    const listed = await runMain(["roots"], { home, tty: true });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("Roots are retired.");
    expect(listed.stdout).toContain("its project's folder");
    const json = await runMain(["roots", "list", "--json"], { home });
    expect(JSON.parse(json.stdout)).toEqual({ roots: [], retired: true });

    const added = await runMain(["roots", "add", "oss", join(root, "oss"), "--json"], {
      home,
      tty: true,
    });
    expect(added.code).not.toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ error: { code: "invalid_input" } });
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});
