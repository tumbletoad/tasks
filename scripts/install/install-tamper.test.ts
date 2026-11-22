// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { downloadCases, installerIn, listing, VERIFIERS } from "./test/kit.ts";
import {
  base,
  canary,
  expectRefused,
  homes,
  install,
  release,
  SLOW,
  useInstallFolder,
  work,
} from "./test/install-file.ts";

useInstallFolder("tamper");

describe("[A2.3.12.4.install.tamper] a tampered download is refused before any candidate file runs", () => {
  test(
    "a tampered archive or SHA256SUMS, through each verifier path",
    () => {
      for (const verifier of VERIFIERS) {
        const cases = downloadCases(release, base, join(work, "tamper"), canary, verifier);
        for (const c of cases) {
          const root = join(homes, `tamper-${verifier}-${c.name}`);
          const before = listing(homes);
          const ran = install({
            root,
            source: c.source,
            installer: installerIn(release, c.source),
            verifier,
          });
          try {
            expect(ran.stderr).toMatch(/Cannot verify this download/);
            expectRefused(ran, c.reason, before, homes);
          } catch (error) {
            throw new Error(`${verifier}, ${c.name}: ${String(error)}`, { cause: error });
          }
        }
      }
    },
    SLOW,
  );
});
