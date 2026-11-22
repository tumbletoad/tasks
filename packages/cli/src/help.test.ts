// The CLI's help (A2 3.10.1): every command of the verb table and every generated verb has its own
// help, printed the same by `ttasks help <command>` and `ttasks <command> --help`, with its forms
// and flags; a flag the contract requires is marked so; the columns of each help line up. No
// service is needed: help runs nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { SERVICE_VERBS } from "@ttasks/service/install";
import { CLI_SPEC } from "./args.ts";
import { LOCAL_COMMANDS, shortHelp, verbHelp } from "./help.ts";
import { main, type Io } from "./main.ts";

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

async function helpOf(argv: readonly string[]): Promise<string> {
  const io = recorder(argv);
  // A help that started the bridge would wait on stdin: none may.
  expect(await main(io, { mcp: () => Promise.reject(new Error("the bridge started")) })).toBe(0);
  expect(io.err).toBe("");
  return io.out;
}

const COMMANDS = [...CLI_SPEC.verbs.map((v) => v.verb), ...LOCAL_COMMANDS.map((c) => c.name)];

describe("[A2.3.10.cli.help] help for every command", () => {
  test("every command has its own help, the same from help <command> and <command> --help", async () => {
    const list = shortHelp();
    for (const command of COMMANDS) {
      const help = await helpOf(["help", command]);
      expect(help, command).not.toBe(list);
      expect(help, command).toMatch(new RegExp(`^Usage: ttasks ${command}\\b`));
      // `ttasks mcp …` is the bridge's own command line (A2 3.7.1): its help is `ttasks help mcp`
      // and `ttasks --help mcp`.
      const flagged = command === "mcp" ? ["--help", command] : [command, "--help"];
      expect(await helpOf(flagged), command).toBe(help);
    }
    // The list names every command once.
    for (const command of COMMANDS) {
      expect(list.match(new RegExp(`^ {2}${command} {2,}`, "gm")), command).toHaveLength(1);
    }
  });

  test("every command the router takes is in the table, so none is left without help", () => {
    // The router is main.ts's one switch: each of its cases is a command a person can type.
    const router = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");
    const routed = [...router.matchAll(/^\s+case "([a-z][a-z0-9-]*)":/gm)].map((m) => m[1]);
    expect(routed.length).toBeGreaterThan(5);
    const table = new Set(LOCAL_COMMANDS.map((c) => c.name));
    expect(routed.filter((name) => name !== undefined && !table.has(name))).toEqual([]);
  });

  test("a command's subcommands are in its help, and the service's are the ones it takes", () => {
    for (const command of LOCAL_COMMANDS) {
      for (const sub of command.subcommands ?? []) {
        expect(command.help, `${command.name} ${sub}`).toMatch(
          new RegExp(`(^ {2}|ttasks ${command.name} )${sub}\\b`, "m"),
        );
      }
    }
    const service = LOCAL_COMMANDS.find((c) => c.name === "service");
    expect([...(service?.subcommands ?? [])].sort()).toEqual([...SERVICE_VERBS, "port"].sort());
  });

  test("an operation verb's help marks the flags its contract requires", async () => {
    let checked = 0;
    for (const verb of CLI_SPEC.verbs) {
      const help = await helpOf(["help", verb.verb]);
      const usage = help.split("\n")[0] ?? "";
      for (const flag of verb.flags) {
        const line = help
          .split("\n")
          .find((l) => l.match(new RegExp(`^ {2}(-\\w, )?${flag.flag}\\b`)));
        expect(line, `${verb.verb} ${flag.flag}`).toBeDefined();
        expect(line?.endsWith("(required)"), `${verb.verb} ${flag.flag}`).toBe(flag.required);
        expect(usage.includes(` ${flag.flag}`), `${verb.verb} ${flag.flag}`).toBe(flag.required);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
    // No flag of today's contract is required, so a verb whose flag is shows how one reads.
    const reopen = CLI_SPEC.verbs.find((verb) => verb.verb === "reopen");
    if (reopen === undefined) throw new Error("ttasks reopen is a verb");
    const strict = {
      ...reopen,
      flags: reopen.flags.map((f) => (f.flag === "--reason" ? { ...f, required: true } : f)),
    };
    const lines = verbHelp(strict).split("\n");
    expect(lines[0]).toBe("Usage: ttasks reopen [<task>] --reason <reason> [options]");
    expect(lines.find((line) => line.startsWith("  --reason"))).toMatch(/ \(required\)$/);
  });

  test("ttasks --version prints the version, as ttasks version does", async () => {
    const version = await helpOf(["version"]);
    expect(version).toMatch(/\d+\.\d+\.\d+/);
    expect(await helpOf(["--version"])).toBe(version);
  });

  test("a command that does not exist is named with the command's own name", async () => {
    const io = recorder(["misspelled"]);
    expect(await main(io)).not.toBe(0);
    expect(io.err).toContain(`${CLI_NAME} has no command misspelled.`);
    expect(io.err.match(/\S*tasks\b/gi)).toEqual([CLI_NAME, CLI_NAME]);
  });

  test("the description column of each help lines up", () => {
    for (const command of LOCAL_COMMANDS) {
      const columns = new Set<number>();
      for (const line of command.help.split("\n")) {
        const found = /^ {2}\S.*?\S( {2,})\S/.exec(line);
        if (found !== null) columns.add(found.index + found[0].length - 1);
      }
      expect([...columns], command.name).toHaveLength(columns.size === 0 ? 0 : 1);
    }
  });
});
