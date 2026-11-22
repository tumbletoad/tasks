// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { HOME_VAR, listing, runProgram, stableCommand, VERIFIERS, windows } from "./test/kit.ts";
import {
  expectInstalled,
  homes,
  install,
  release,
  SLOW,
  useInstallFolder,
} from "./test/install-file.ts";

useInstallFolder("script");

describe("[A2.3.12.4.install.script] install.sh and install.ps1 make a separate install in a temporary TTASKS_HOME", () => {
  test(
    "through each verifier path: the signature, the hash, the self-test through the version's own launcher, then current",
    () => {
      const ids = new Set<string>();
      for (const verifier of VERIFIERS) {
        const root = join(homes, `good-${verifier}`);
        const ran = install({ env: { [HOME_VAR]: root }, verifier });
        expectInstalled(root, ran);
        // The self-test came before the switch, and the offer of the service install after it.
        expect(ran.stdout.indexOf("ok    candidate-bridge")).toBeLessThan(
          ran.stdout.indexOf("Installed"),
        );
        expect(ran.stdout).toContain(`${stableCommand(root)} service install`);
        const version = runProgram(stableCommand(root), ["version"]);
        expect(version.stdout.trim()).toBe(`${PRODUCT_NAME} ${release.version} (${release.build})`);
        const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
          install_id: string;
          created: string[];
        };
        ids.add(record.install_id);
        expect(record.created).toEqual(
          [
            ".",
            "bin",
            ...(windows
              ? [`bin/${PRODUCT_ID}.exe`, `bin/${PRODUCT_ID}w.exe`]
              : [`bin/${PRODUCT_ID}`]),
            "current",
            "home.marker",
            "state",
            "versions",
            `versions/${release.version}`,
          ].sort(),
        );
      }
      // Each install has its own install ID, from its own state folder (A2 3.2.1).
      expect(ids.size).toBe(VERIFIERS.length);
    },
    SLOW,
  );

  test(
    "--root names the root as TTASKS_HOME does, the install's doctor passes, and nothing outside the root changes",
    () => {
      const root = join(homes, "by-parameter");
      const before = listing(homes);
      const ran = install({ root });
      expectInstalled(root, ran);
      const after = listing(homes).filter((path) => !before.includes(path));
      expect(after.every((path) => path.startsWith("by-parameter/"))).toBe(true);
      const doctor = runProgram(stableCommand(root), ["doctor", "--self-test", "--json"]);
      const rows = (JSON.parse(doctor.stdout) as { checks: { id: string; status: string }[] })
        .checks;
      for (const id of [
        "integrity",
        "runtime",
        "install",
        "candidate-space",
        "candidate-endpoint",
        "candidate-bridge",
      ]) {
        expect(rows.find((row) => row.id === id)?.status, `${id}: ${doctor.stdout}`).toBe("ok");
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "from PowerShell 7, and from Windows PowerShell 5.1 with PowerShell 7's module path through the node verifier (A2 3.12.4)",
    () => {
      const seven = join(homes, "pwsh");
      expectInstalled(seven, install({ root: seven, powershell: "7" }));
      const inherited = join(homes, "module-path");
      expectInstalled(
        inherited,
        install({ root: inherited, verifier: "node", modulePath: "inherit" }),
      );
    },
    SLOW,
  );
});
