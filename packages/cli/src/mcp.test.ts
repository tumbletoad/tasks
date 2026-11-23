// `ttasks mcp` in the router (A2 3.10.1): the arguments after `mcp` go to the bridge as
// they are, its exit code is the command's, and the CLI writes nothing around it. bin.ts hands
// over before it loads the router; this is the same verb for callers of main().
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SLOTS, main, type Io } from "./main.ts";
import { isBridge, MCP_VERB } from "./mcp.ts";

function recorder(argv: readonly string[]): Io & { out: string; err: string } {
  const io = {
    argv,
    env: {},
    cwd: process.cwd(),
    platform: process.platform,
    tty: { stdin: false, stdout: false, stderr: false },
    pid: process.pid,
    out: "",
    err: "",
    stdout(text: string) {
      io.out += text;
    },
    stderr(text: string) {
      io.err += text;
    },
    readStdin: () => Promise.resolve(""),
    readFile: () => Promise.reject(new Error("no file")),
  };
  return io;
}

describe("[A2.3.7.bridge.cli-entry] the router's mcp verb", () => {
  test("the slot is filled and the verb is mcp", () => {
    expect(MCP_VERB).toBe("mcp");
    expect(SLOTS.mcp).toBeTypeOf("function");
  });

  test("ttasks mcp --help is the CLI's help, before any connection; the entries route it the same", () => {
    expect(isBridge(["mcp", "--space", "sp_x"])).toBe(true);
    expect(isBridge(["mcp"])).toBe(true);
    for (const argv of [["mcp", "--help"], ["mcp", "-h"], ["mcp", "--space", "sp_x", "--help"]]) {
      expect(isBridge(argv), argv.join(" ")).toBe(false);
    }
    for (const file of ["./bin.ts", "./entry.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).toContain("if (isBridge(argv)) {");
    }
  });

  test("the arguments after mcp reach the bridge unparsed, and its exit code is the command's", async () => {
    for (const code of [0, 1, 2]) {
      const seen: (readonly string[])[] = [];
      const io = recorder(["mcp", "--space", "sp_x", "--json", "--request-id", "r1"]);
      const result = await main(io, {
        mcp: (argv) => {
          seen.push(argv);
          return Promise.resolve(code);
        },
      });
      expect(result).toBe(code);
      expect(seen).toEqual([["--space", "sp_x", "--json", "--request-id", "r1"]]);
      expect(io.out).toBe("");
      expect(io.err).toBe("");
    }
  });

  test("a CLI option before mcp is a usage error and the bridge does not start", async () => {
    for (const argv of [
      ["--space", "sp_x", "mcp"],
      ["--json", "mcp"],
      ["-q", "mcp", "--space", "sp_x"],
    ]) {
      let started = false;
      const io = recorder(argv);
      const result = await main(io, {
        mcp: () => {
          started = true;
          return Promise.resolve(0);
        },
      });
      expect(result, argv.join(" ")).toBe(2);
      expect(started).toBe(false);
      expect(`${io.out}${io.err}`).toContain("ttasks mcp");
    }
  });

  test("help lists mcp", async () => {
    const io = recorder(["help"]);
    expect(await main(io)).toBe(0);
    expect(io.out).toMatch(/^ {2}mcp {2,}/m);
  });
});
