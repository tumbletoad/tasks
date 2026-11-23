// `ttasks service` through the CLI (A2 3.10.1, M1.12's entries). Only routes that end
// before anything is read are run here: a usage error, and an agent's shell, which install,
// uninstall and stop refuse first. No test of the CLI reaches the real Run key, a unit folder or a
// service manager; the commands themselves are tested in packages/service with stand-ins.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeContext } from "@ttasks/service/test/install-fakes";
import { main, SLOTS, type Io } from "./main.ts";

function recorder(argv: readonly string[], env: Record<string, string>) {
  const io = {
    argv,
    env,
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
  } satisfies Io & { out: string; err: string };
  return io;
}

describe("[A2.3.3.5.service-install.commands] ttasks service through the CLI", () => {
  test("ttasks service is routed to the service install: its verbs and flags, usage errors that quote nothing, an agent's shell refused", async () => {
    expect(SLOTS.service).toBeDefined();
    const home = mkdtempSync(join(tmpdir(), "kc-svc-"));
    try {
      for (const [argv, words] of [
        [["service"], "ttasks service takes one of install, uninstall, start, stop, restart"],
        [["service", "reload"], "ttasks service takes one of install, uninstall, start, stop"],
        [["service", "install", "--force-me"], "ttasks service install has no option --force-me"],
        [["service", "status", "secret-value"], "ttasks service status takes no argument like"],
      ] as const) {
        const io = recorder(argv, { TTASKS_HOME: home });
        expect(await main(io)).toBe(2);
        expect(io.err).toContain(words);
        expect(io.err).toContain("Run ttasks service --help");
        expect(io.err).not.toMatch(/secret-value/);
      }
      // An agent's shell may not install, uninstall, stop or restart: refused before anything is
      // read.
      const agent = { TTASKS_HOME: home, CODEX_THREAD_ID: "t1" };
      // A preview of a verb that has none is a usage error, before the agent's-shell check: it
      // never reaches the service.
      for (const verb of ["start", "stop", "restart", "status"]) {
        const preview = recorder(["service", verb, "--dry-run"], agent);
        expect(await main(preview)).toBe(2);
        expect(preview.err).toContain(`ttasks service ${verb} has no option --dry-run`);
      }
      for (const verb of ["stop", "restart"]) {
        const refused = recorder(["service", verb], agent);
        expect(await main(refused)).toBe(5);
        expect(refused.err).toContain(`ttasks service ${verb} is not run from an agent's shell`);
      }
      // --json is the CLI's global flag, and the entry prints one JSON document.
      const install = recorder(["--json", "service", "install", "--yes"], agent);
      expect(await main(install)).toBe(5);
      expect(JSON.parse(install.out)).toMatchObject({
        error: { code: "agent_shell", class: "forbidden" },
      });
      // Help names the command.
      const help = recorder(["help"], { TTASKS_HOME: home });
      expect(await main(help)).toBe(0);
      expect(help.out).toMatch(
        /\n {2}service +Install, uninstall, start, stop, restart or show the service/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a service verb refuses every option it does not read, the CLI's own included, before the service is reached", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "kc-svc-opts-")));
    try {
      const fake = fakeContext({ platform: "win32", dir });
      const options = { serviceContext: () => fake.ctx };
      fake.service.start("ttasksw");
      const env = { TTASKS_HOME: join(dir, "empty-home") };
      // The stand-in is reached: a plain stop is recorded.
      expect(await main(recorder(["service", "stop"], env), options)).toBe(0);
      expect(fake.service.events).toEqual(["start ttasksw", "stop"]);
      fake.service.start("ttasksw");

      const before = [...fake.service.events];
      const probes = fake.service.budgets.length;
      const verbs = [
        ["install"],
        ["uninstall"],
        ["start"],
        ["stop"],
        ["restart"],
        ["status"],
        ["port", "7123", "--reuse", "--yes"],
      ];
      const globals: Record<string, string | undefined> = {
        "--space": "Mira",
        "--request-id": "fixture-request-000001",
        "--timeout": "5",
        "--input": "preview.json",
        "-q": undefined,
        "--quiet": undefined,
        "--verbose": undefined,
        "--no-color": undefined,
      };
      for (const [verb = "", ...own] of verbs) {
        for (const [option, value] of Object.entries(globals)) {
          const forms = [
            // A value option takes the preview as its value: the verb then sees no preview.
            [option, "--dry-run"],
            value === undefined ? [option] : [option, value],
            ...(value === undefined ? [] : [[`${option}=${value}`]]),
          ];
          for (const form of forms) {
            const flagBeforeCommand = value === undefined && form.length > 1;
            for (const argv of [
              ["service", verb, ...own, ...form],
              ...(flagBeforeCommand ? [] : [[...form, "service", verb, ...own]]),
            ]) {
              const io = recorder(argv, env);
              expect(await main(io, options), argv.join(" ")).toBe(2);
              expect(io.err, argv.join(" ")).toContain(option);
              if (!io.err.includes(" takes ")) {
                expect(io.err).toContain(`ttasks service ${verb} has no option ${option}`);
                expect(io.err).toContain("Run ttasks service --help");
              }
            }
          }
        }
        // The verb's own options and --json: every preview a verb does not have is refused.
        const previews = verb === "install" || verb === "uninstall";
        for (const [extra, code] of [
          [["--dry-run"], previews ? 0 : 2],
          [["--dry-run", "--json"], previews ? 0 : 2],
          [["--space"], 2],
        ] as const) {
          expect(await main(recorder(["service", verb, ...own, ...extra], env), options)).toBe(
            code,
          );
        }
      }
      expect(fake.service.events).toEqual(before);
      expect(fake.service.budgets.length).toBe(probes);
      expect(fake.tools.calls).toEqual([]);
      expect(fake.detached).toEqual([]);

      // --yes goes with install, uninstall and port --reuse, and the words say which verb.
      const yes = recorder(["service", "port", "7123", "--yes", "--dry-run"], env);
      expect(await main(yes, options)).toBe(2);
      expect(yes.err).toContain("ttasks service port has no option --dry-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
