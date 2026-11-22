// The install scripts (A7 3.8 M1.14, A2 3.12.4): install.sh on Linux and install.ps1 on Windows,
// run as a person runs them, on the run's release (scripts/install/test/install-file.ts). Every
// install goes into a root below a temporary folder of this file's own; nothing touches the real
// install root, PATH, a profile, a start-up entry or the registry. The canary stand-ins prove that
// a refused download ran nothing: each writes a file when it runs, in any way, and the canary
// folder must stay empty. One file per part (install-*.test.ts), so the parts run side by side.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  craftTarGz,
  craftZip,
  entriesOf,
  installerIn,
  listing,
  lookAlikeFolder,
  packFolder,
  powershell51,
  present,
  proveStandInsFire,
  signedSource,
  windows,
} from "./test/kit.ts";
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

useInstallFolder("tamper-signed");

describe("[A2.3.12.4.install.tamper] a tampered download is refused before any candidate file runs", () => {
  test(
    "a signed archive whose file changed after hashing, or that holds a name leaving its folder or a link, is refused before anything from it runs",
    () => {
      // Signed with the release's own key, so the signature and the hash pass: what stops each is
      // the check of the unpacked files against manifest.json, or of the archive's entries.
      const changed = lookAlikeFolder(base, join(work, "changed", release.version), canary, false);
      proveStandInsFire(changed, canary);
      const escape = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "xx/xx/xx/escape.txt", data: Buffer.from("escaped\n"), mode: 0o644 },
            ]),
            { from: "xx/xx/xx/escape.txt", to: "../../../escape.txt" },
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "../../../escape.txt", data: Buffer.from("escaped\n") },
          ]);
      const link = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "lib/linked.mjs", data: Buffer.from("C:\\Windows\\win.ini"), mode: 0o644 },
            ]),
            undefined,
            "lib/linked.mjs",
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "lib/linked.mjs", link: "/etc/hostname" },
          ]);
      const absolute = windows
        ? craftZip(
            entriesOf(base, release.platform, [
              { path: "xx/escape.txt", data: Buffer.from("escaped\n"), mode: 0o644 },
            ]),
            { from: "xx/escape.txt", to: "C:/escape.txt" },
          )
        : craftTarGz([
            ...entriesOf(base, release.platform).map((e) => ({ path: e.path, data: e.data })),
            { path: "/tmp/escape.txt", data: Buffer.from("escaped\n") },
          ]);
      const cases: [string, Buffer, RegExp][] = [
        ["changed", packFolder(changed, release.platform), /do not match manifest\.json/],
        ["escape", escape, /a name that could leave its folder/],
        ["absolute", absolute, /a name that could leave its folder/],
        ["link", link, /not a plain file or folder/],
      ];
      for (const [name, archive, reason] of cases) {
        const source = signedSource(release, join(work, "signed", name), archive, work);
        const root = join(homes, `signed-${name}`);
        const before = listing(homes);
        const ran = install({ root, source, installer: installerIn(release, source) });
        try {
          expectRefused(ran, reason, before, homes);
          expect(present(join(work, "escape.txt"))).toBe(false);
        } catch (error) {
          throw new Error(`${name}: ${String(error)}`, { cause: error });
        }
      }
    },
    SLOW,
  );

  test.runIf(windows)(
    "a folder of the run whose file Windows still holds for a moment is removed once the file is let go",
    async () => {
      // As an antivirus scan holds the verifier's node.exe it has just seen run: a handle without
      // delete sharing, until `release` appears.
      const held = join(work, "held");
      const download = join(held, ".download-held");
      const file = join(download, "verifier", "node.exe");
      const release = join(held, "release");
      mkdirSync(join(download, "verifier"), { recursive: true });
      writeFileSync(file, "");
      const script = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");
      const removeTree = /^function Remove-Tree\([\s\S]*?^\}\r?$/mu.exec(script)?.[0];
      expect(removeTree, "install.ps1 removes its folders through Remove-Tree").toBeDefined();
      writeFileSync(
        join(held, "hold.ps1"),
        `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read')\n[Console]::Out.WriteLine('held')\n` +
          `while (-not [IO.File]::Exists('${release}')) { [Threading.Thread]::Sleep(20) }\n$f.Dispose()\n`,
      );
      writeFileSync(
        join(held, "remove.ps1"),
        `${removeTree ?? ""}\n[Console]::Out.WriteLine('removing')\nRemove-Tree '${download}'\n`,
      );
      const holder = powershellFile(join(held, "hold.ps1"));
      try {
        await holder.said("held");
        const remover = powershellFile(join(held, "remove.ps1"));
        await remover.said("removing");
        // Let Remove-Tree meet the held file before it is let go.
        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(release, "");
        expect(await remover.exited, remover.output()).toBe(0);
        expect(existsSync(download)).toBe(false);
      } finally {
        writeFileSync(release, "");
        await holder.exited;
      }
    },
    SLOW,
  );
});

/** A Windows PowerShell 5.1 script as a child: what it said, and its exit code. */
function powershellFile(path: string): {
  said(line: string): Promise<void>;
  output(): string;
  exited: Promise<number | null>;
} {
  const child = spawn(powershell51(), ["-NoProfile", "-NonInteractive", "-File", path], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  const waiting: { line: string; resolve: () => void }[] = [];
  const onData = (chunk: string): void => {
    out += chunk;
    for (const wait of waiting.filter((w) => out.split(/\r?\n/u).includes(w.line))) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
  };
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", onData);
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  return {
    said: (line) =>
      new Promise<void>((resolve, reject) => {
        if (out.split(/\r?\n/u).includes(line)) {
          resolve();
          return;
        }
        waiting.push({ line, resolve });
        void exited.then(() => {
          reject(new Error(`exited before it said ${line}: ${out}`));
        });
      }),
    output: () => out,
    exited,
  };
}
