// `ttasks doctor` and `ttasks setup agents --status` say per instance whether its app is installed,
// its version, whether it is signed in, and what to do next, against the testkit's stand-in
// commands, whose status commands say signed in while a marker file is in the app's home.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { configOf } from "@ttasks/service/test/harness";
import { FAKE_SIGNED_IN } from "@ttasks/testkit/fake-agents";
import {
  doctor,
  fakes,
  home,
  row,
  run,
  SLOW,
  useDoctorWorld,
  user,
  windows,
} from "./doctor-agents-world.ts";

useDoctorWorld();

/** A stand-in's command as setup instances finds it on the PATH: npm's shim on Windows. */
const program = (name: string) => join(fakes.bin, windows ? `${name}.cmd` : name);

const instances = (work: string, gone: string) =>
  [
    "[[instance]]",
    'id = "claude"',
    'target = "claude-cli"',
    'label = "Claude Code"',
    `exec = '${program("claude")}'`,
    "",
    "[[instance]]",
    'id = "claude-work"',
    'target = "claude-cli"',
    'label = "Claude Code (work)"',
    `exec = '${program("claude")}'`,
    `config_home = '${work}'`,
    "",
    "[[instance]]",
    'id = "codex"',
    'target = "codex-cli"',
    'label = "Codex"',
    `exec = '${program("codex")}'`,
    "",
    "[[instance]]",
    'id = "claude-gone"',
    'target = "claude-cli"',
    'label = "Claude Code (gone)"',
    `exec = '${gone}'`,
    "",
  ].join("\n");

describe("[A3.3.14.doctor.readiness] doctor and setup agents say whether each instance is installed and signed in", () => {
  test(
    "installed with its version and signed in, not signed in with the login line for its own home, not installed with the vendor's page; the status command's output never shows",
    async () => {
      const work = join(user, ".claude-work");
      mkdirSync(work, { recursive: true });
      mkdirSync(configOf(home), { recursive: true, mode: 0o700 });
      const config = join(configOf(home), "machine.toml");
      writeFileSync(config, instances(work, join(user, "nowhere", "claude")), { mode: 0o600 });
      writeFileSync(join(user, ".claude", FAKE_SIGNED_IN), "");
      try {
        const report = await doctor();
        expect(row(report, "ready.claude")).toEqual({
          id: "ready.claude",
          status: "ok",
          detail: "claude: installed 2.1.9 · signed in",
        });
        const signedOut = row(report, "ready.claude-work");
        expect(signedOut?.status).toBe("warn");
        expect(signedOut?.detail).toContain("installed 2.1.9 · not signed in: run ");
        expect(signedOut?.detail).toContain(work);
        expect(signedOut?.detail).toMatch(/claude auth login$/u);
        expect(row(report, "ready.codex")?.detail).toBe(
          "codex: installed 0.167.2 · not signed in: run codex login",
        );
        expect(row(report, "ready.claude-gone")).toEqual({
          id: "ready.claude-gone",
          status: "warn",
          detail: "claude-gone: not installed: see https://code.claude.com/docs/en/setup",
        });
        expect(JSON.stringify(report)).not.toContain("FAKE-ACCOUNT-SECRET");

        const status = await run(["setup", "agents", "--status"]);
        expect(status.code, status.stderr).toBe(0);
        expect(status.stdout).toContain("  installed 2.1.9 · signed in\n");
        expect(status.stdout).toContain("  installed 0.167.2 · not signed in: run codex login\n");
        expect(status.stdout + status.stderr).not.toContain("FAKE-ACCOUNT-SECRET");
        const json = await run(["setup", "agents", "--status", "--json"], undefined, false);
        const homes = (JSON.parse(json.stdout) as { homes: { app: string; ready?: unknown }[] })
          .homes;
        expect(homes.find((h) => h.app === "codex")?.ready).toEqual({
          state: "signed_out",
          version: "0.167.2",
          login: "codex login",
        });
      } finally {
        rmSync(config, { force: true });
        rmSync(join(user, ".claude", FAKE_SIGNED_IN), { force: true });
      }
    },
    SLOW,
  );
});
