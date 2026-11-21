import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalStatePath, installId, resolveLayout, type HostFacts } from "../hub/paths.ts";
import {
  defaultProgram,
  EntryPathError,
  execPath,
  execWords,
  isOwnPlist,
  isOwnRunData,
  isOwnUnit,
  LAUNCHD_WRAPPER,
  plistNotOurs,
  readPlist,
  REGISTRY_ROOT,
  renderPlist,
  renderRunValue,
  renderUnit,
  runDataNotOurs,
  runKeys,
  serviceNames,
  startupApproved,
  unitNotOurs,
  WRITTEN_BY,
  type ServicePlatform,
} from "./render.ts";

const golden = (name: string): string =>
  readFileSync(new URL(`../../test/golden/install/${name}`, import.meta.url), "utf8");

/** Launcher paths with what systemd quotes, escapes or expands: spaces, quotes, %, $, \, non-ASCII. */
const HOSTILE_PATHS = [
  "/home/m ira/100%/$HOME/a;b&c(d)[e]=f/current/bin/ttasks",
  "/home/Mïra 日本/ttasks-s3/current/bin/ttasks",
  "/tmp/%h %%/x$$y ${HOME}/current/bin/ttasks",
  // About 300 characters, in folders within the file system's 255-byte name limit.
  `/home/m/${Array.from({ length: 16 }, (_, n) => `long folder ${String(n)}`).join("/")}/current/bin/ttasks`,
];

/** systemd-analyze, where systemd is installed: it reads unit files and starts nothing. */
const systemdAnalyze =
  process.platform === "linux" &&
  spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).status === 0;

/** Mira's machines (fixture names), the daily install and a TTASKS_HOME test install on each. */
const HOMES = { linux: "/home/mira", darwin: "/Users/mira", win32: "C:\\Users\\mira" } as const;
const TEST_HOMES = {
  linux: "/home/mira/ttasks-test",
  darwin: "/Users/mira/ttasks-test",
  win32: "C:\\Users\\mira\\ttasks-test",
} as const;

function install(platform: ServicePlatform, separate: boolean) {
  const env: Record<string, string> =
    platform === "win32" ? { USERPROFILE: HOMES.win32 } : { HOME: "/tmp/sandbox" };
  if (separate) env["TTASKS_HOME"] = TEST_HOMES[platform];
  const facts: HostFacts = {
    platform,
    env,
    accountHome: platform === "win32" ? undefined : HOMES[platform],
    uid: 501,
  };
  const layout = resolveLayout(facts);
  const id = installId(canonicalStatePath(layout.state, platform));
  return {
    layout,
    id,
    names: serviceNames(id, layout.home !== undefined),
    program: defaultProgram(platform, layout),
  };
}

describe("[A2.3.3.service-install.golden] the OS entries per install ID, against golden files", () => {
  test("Linux: the systemd user unit of A2 3.3.3, plain for the daily install, ttasks-<id> for a test install", () => {
    const daily = install("linux", false);
    expect(daily.id).toBe("7yj6swwdz7");
    expect(daily.names.unit).toBe("ttasks.service");
    expect(renderUnit({ program: daily.program })).toBe(golden("ttasks.service"));

    const test = install("linux", true);
    expect(test.id).toBe("0rsmfcnh8j");
    expect(test.names.unit).toBe("ttasks-0rsmfcnh8j.service");
    expect(renderUnit({ program: test.program, tasksHome: test.layout.home })).toBe(
      golden("ttasks-0rsmfcnh8j.service"),
    );
  });

  test("Windows: the HKCU Run value of A2 3.3.2 and the StartupApproved key beside it", () => {
    const values = JSON.parse(golden("run-values.json")) as Record<string, unknown>;
    expect(runKeys(REGISTRY_ROOT)).toEqual({
      run: values["run_key"],
      approved: values["startup_approved_key"],
    });
    for (const [kind, separate] of [
      ["daily", false],
      ["separate", true],
    ] as const) {
      const { id, names, program } = install("win32", separate);
      expect({ install_id: id, ...renderRunValue(names.runValue, program) }).toEqual(values[kind]);
    }
  });

  test("macOS: the LaunchAgent of A2 3.3.4 with the ttasks-launchd wrapper, local.ttasks.service[.<id>]", () => {
    const daily = install("darwin", false);
    expect(daily.names.label).toBe("local.ttasks.service");
    expect(
      renderPlist({
        label: daily.names.label,
        program: daily.program,
        home: HOMES.darwin,
        logs: daily.layout.logs,
      }),
    ).toBe(golden("local.ttasks.service.plist"));

    const test = install("darwin", true);
    expect(test.id).toBe("sgph75g0sh");
    expect(test.names.label).toBe("local.ttasks.service.sgph75g0sh");
    expect(
      renderPlist({
        label: test.names.label,
        program: test.program,
        home: HOMES.darwin,
        logs: test.layout.logs,
      }),
    ).toBe(golden("local.ttasks.service.sgph75g0sh.plist"));
  });

  test("two test installs whose folders end in the same name get different unit, Run value and label names (SL-03)", () => {
    const named = (home: string) => {
      const layout = resolveLayout({
        platform: "linux",
        env: { TTASKS_HOME: home },
        accountHome: "/home/mira",
        uid: 1000,
      });
      return serviceNames(installId(canonicalStatePath(layout.state, "linux")), true);
    };
    const a = named("/home/mira/a/ttasks-test");
    const b = named("/home/mira/b/ttasks-test");
    expect(a.unit).not.toBe(b.unit);
    expect(a.runValue).not.toBe(b.runValue);
    expect(a.label).not.toBe(b.label);
    expect(serviceNames("pk6sg0pfd5", true)).toEqual({
      unit: "ttasks-pk6sg0pfd5.service",
      runValue: "TTasks (pk6sg0pfd5)",
      label: "local.ttasks.service.pk6sg0pfd5",
    });
    expect(() => serviceNames("../../etc", true)).toThrow(TypeError);
  });

  test("paths that systemd, the registry or a plist would read differently are quoted or refused", () => {
    // systemd: quotes, C escapes and %% for specifiers. No $$: systemd never expands variables in
    // the path it executes, so a $ there stays a $.
    expect(execPath("/home/mira/.local/share/ttasks/current/bin/ttasks")).toBe(
      "/home/mira/.local/share/ttasks/current/bin/ttasks",
    );
    expect(execPath('/home/m ira/100%/$HOME/a"b\\c/tasks')).toBe(
      '"/home/m ira/100%%/$HOME/a\\"b\\\\c/tasks"',
    );
    const unit = renderUnit({
      program: "/home/m ira/100%/ttasks/current/bin/ttasks",
      tasksHome: "/home/m ira/100%/tasks",
    });
    expect(unit).toContain('ExecStart="/home/m ira/100%%/ttasks/current/bin/ttasks" serve\n');
    expect(unit).toContain("Description=TTasks service (TTASKS_HOME=/home/m ira/100%%/tasks)\n");
    expect(isOwnUnit(unit)).toBe(true);
    // The words install writes come back as the path it was given.
    for (const path of HOSTILE_PATHS) {
      expect(execWords(`${execPath(path)} serve`)).toEqual([path, "serve"]);
      expect(isOwnUnit(renderUnit({ program: path }))).toBe(true);
    }
    // A plist escapes XML's three characters.
    const plist = renderPlist({
      label: "local.ttasks.service",
      program: "/Users/a&b/<x>/current/bin/ttasks-launchd",
      home: "/Users/a&b",
      logs: "/Users/a&b/logs",
    });
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;x&gt;/current/bin/ttasks-launchd</string>");
    // Relative paths and control characters are refused everywhere, and systemd takes no quote,
    // apostrophe or backslash in a program path, escaped or not.
    for (const bad of [
      "relative/tasks",
      "/home/mira/new\nline/tasks",
      "/home/x\u0000/tasks",
      '/home/a"b/current/bin/ttasks',
      "/home/O'Neil/current/bin/ttasks",
      "/home/a\\b/current/bin/ttasks",
    ]) {
      expect(() => renderUnit({ program: bad })).toThrow(EntryPathError);
    }
    expect(() => renderRunValue("Tasks", "bin\\ttasksw.exe")).toThrow(EntryPathError);
    expect(() => renderRunValue("Tasks", "C:\\a\r\nb\\ttasksw.exe")).toThrow(EntryPathError);
    expect(() =>
      renderPlist({ label: "x", program: "ttasks-launchd", home: "/Users/m", logs: "/Users/m" }),
    ).toThrow(EntryPathError);
  });

  test.skipIf(!systemdAnalyze)(
    "systemd itself finds the launcher at each hostile path in the unit install writes",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "ttasks-unit-"));
      try {
        for (const [n, path] of HOSTILE_PATHS.entries()) {
          const program = `${dir}${path}`;
          mkdirSync(dirname(program), { recursive: true });
          writeFileSync(program, "#!/bin/sh\nexit 0\n");
          chmodSync(program, 0o755);
          const unit = join(dir, `ttasks-verify${String(n)}.service`);
          writeFileSync(unit, renderUnit({ program }));
          // `verify` loads the unit offline and fails when its ExecStart is not an executable file.
          const result = spawnSync("systemd-analyze", ["verify", "--man=no", unit], {
            encoding: "utf8",
          });
          const ours = `${result.stdout}${result.stderr}`
            .split("\n")
            .filter((line) => line.includes(`ttasks-verify${String(n)}`));
          expect(ours).toEqual([]);
          expect(result.status).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("an entry at the install's name is ours only when it starts a TTasks launcher", () => {
    expect(isOwnUnit(golden("ttasks.service"))).toBe(true);
    expect(isOwnUnit("[Service]\nExecStart=/opt/other/bin/ttasks serve\n")).toBe(true);
    expect(isOwnUnit('[Service]\nExecStart="/opt/o t/bin/ttasks" serve\n')).toBe(true);
    expect(isOwnUnit("[Service]\nExecStart=/usr/bin/other-daemon\n")).toBe(false);
    expect(isOwnUnit("[Service]\nExecStart=/usr/bin/ttasks-fake serve\n")).toBe(false);
    // Decided on what the unit makes systemd do, never on the comment install writes.
    const ours = golden("ttasks.service");
    const header = `# ${WRITTEN_BY}\n`;
    expect(ours.startsWith(header)).toBe(true);
    expect(unitNotOurs(ours.replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/other-daemon"))).toBe(
      "not_ours",
    );
    // A later ExecStart= adds a second command; an empty one resets the list.
    expect(unitNotOurs(`${ours}\n[Service]\nExecStart=/usr/bin/other\n`)).toBe("not_ours");
    expect(unitNotOurs(`${ours}\n[Service]\nExecStart=\nExecStart=/usr/bin/other\n`)).toBe(
      "not_ours",
    );
    expect(
      unitNotOurs("[Service]\nExecStart=\nExecStart=/home/m/kh/current/bin/ttasks serve\n"),
    ).toBeUndefined();
    // An ExecStart in another section does not run.
    expect(
      unitNotOurs(
        "[Unit]\nExecStart=/home/m/kh/current/bin/ttasks serve\n[Service]\nExecStart=/usr/bin/other\n",
      ),
    ).toBe("not_ours");
    // A comment line, a prefix or a third word is not the form install writes.
    expect(unitNotOurs("[Service]\n# ExecStart=/x/ttasks serve\nExecStart=/usr/bin/x\n")).toBe(
      "not_ours",
    );
    expect(unitNotOurs("[Service]\nExecStart=-/x/ttasks serve\n")).toBe("not_ours");
    expect(unitNotOurs("[Service]\nExecStart=/x/ttasks serve --other\n")).toBe("not_ours");
    // A continued line is one directive.
    expect(unitNotOurs("[Service]\nExecStart=/x/ttasks \\\n  serve\n")).toBeUndefined();
    // A continuation still open at the end of the file is read, as systemd reads it.
    expect(unitNotOurs(`${ours.trimEnd()}\nAlso=backup.service\\`)).toBe("names_other_units");
    // Words end at ASCII whitespace only: a no-break space is part of the program's name.
    expect(unitNotOurs(`[Service]\nExecStart=/x/tasks${String.fromCharCode(0xa0)}serve\n`)).toBe(
      "not_ours",
    );
    expect(unitNotOurs(`${String.fromCharCode(0xfeff)}${ours}`)).toBeUndefined();
    // Anything install does not write makes the unit someone's own: another command, another
    // variable, another section, a line systemd cannot place. A tuned value of its own does not.
    for (const extra of [
      "[Service]\nExecStartPre=/usr/bin/other",
      "[Service]\nExecStop=/usr/bin/other",
      "[Service]\nEnvironment=LD_PRELOAD=/tmp/x.so",
      "[Service]\nEnvironmentFile=/tmp/env",
      '[Service]\nEnvironment="TTASKS_SERVICE_MANAGER=systemd" "LD_PRELOAD=/tmp/x.so"',
      "[Timer]\nOnBootSec=1",
      ".include /etc/other.service",
      "[Install]\nRequiredBy=other.target\n[Unit\n",
    ]) {
      expect(unitNotOurs(`${ours}\n${extra}\n`)).toBe("other_settings");
    }
    expect(unitNotOurs(ours.replace("RestartSec=2", "RestartSec=10"))).toBeUndefined();
    expect(
      unitNotOurs(
        ours
          .replace("Environment=", 'Environment=\nEnvironment="')
          .replace("systemd\n", 'systemd"\n'),
      ),
    ).toBeUndefined();
    // Also= makes `systemctl disable` change other units: never ours to enable or disable.
    expect(
      unitNotOurs(
        ours.replace("WantedBy=default.target", "WantedBy=default.target\nAlso=backup.service"),
      ),
    ).toBe("names_other_units");
    expect(isOwnRunData('"C:\\Users\\mira\\.local\\bin\\ttasksw.exe"')).toBe(true);
    expect(isOwnRunData('"D:\\Other\\TTASKSW.EXE"')).toBe(true);
    expect(isOwnRunData('"C:\\Program Files\\Other\\other.exe" --tasks')).toBe(false);
    expect(isOwnRunData("C:\\Users\\mira\\.local\\bin\\ttasksw.exe")).toBe(false);
    expect(isOwnRunData('"C:\\x\\ttasksw.exe" --flag')).toBe(false);
    const plist = golden("local.ttasks.service.plist");
    expect(isOwnPlist(plist, "local.ttasks.service")).toBe(true);
    // The comment does not make a plist ours: its label and program must be.
    expect(isOwnPlist(plist, "local.ttasks.service.other")).toBe(false);
    expect(
      isOwnPlist(
        plist.replace("/current/bin/ttasks-launchd", "/bin/other"),
        "local.ttasks.service",
      ),
    ).toBe(false);
    // launchd runs Program instead of ProgramArguments' first string.
    expect(
      isOwnPlist(
        plist.replace(
          "<key>RunAtLoad</key>",
          "<key>Program</key>\n  <string>/bin/other</string>\n  <key>RunAtLoad</key>",
        ),
        "local.ttasks.service",
      ),
    ).toBe(false);
    expect(
      isOwnPlist(
        plist.replace(
          "</string>\n  </array>",
          "</string>\n    <string>--other</string>\n  </array>",
        ),
        "local.ttasks.service",
      ),
    ).toBe(false);
    expect(
      isOwnPlist(
        "<dict><key>Label</key><string>local.ttasks.service</string><key>ProgramArguments</key><array><string>/bin/other</string></array></dict>",
        "local.ttasks.service",
      ),
    ).toBe(false);
    // XML can spell a key another way: anything but install's plain spelling is not ours.
    const withKey = (key: string) =>
      plist.replace(
        "<key>RunAtLoad</key>",
        `${key}\n  <string>/bin/other</string>\n  <key>RunAtLoad</key>`,
      );
    for (const key of [
      "<key>Progr&#97;m</key>",
      "<key>Progr&#x61;m</key>",
      "<key >Program</key>",
      "<key><![CDATA[Program]]></key>",
    ]) {
      expect(plistNotOurs(withKey(key), "local.ttasks.service")).toBe("not_ours");
    }
    expect(
      plistNotOurs(
        plist.replace("<plist", '<!DOCTYPE x [<!ENTITY p "Program">]>\n<plist'),
        "local.ttasks.service",
      ),
    ).toBe("not_ours");
    // A second Label, another key or another variable.
    expect(plistNotOurs(withKey("<key>Label</key>"), "local.ttasks.service")).toBe("not_ours");
    expect(plistNotOurs(withKey("<key>WatchPaths</key>"), "local.ttasks.service")).toBe(
      "other_settings",
    );
    expect(
      plistNotOurs(
        plist.replace(
          "<string>launchd</string>",
          "<string>launchd</string>\n    <key>DYLD_INSERT_LIBRARIES</key>\n    <string>/tmp/x.dylib</string>",
        ),
        "local.ttasks.service",
      ),
    ).toBe("other_settings");
    // Install's own escapes read back.
    const amp = renderPlist({
      label: "local.ttasks.service",
      program: "/Users/a&b/<x>/current/bin/ttasks-launchd",
      home: "/Users/a&b",
      logs: "/Users/a&b/logs",
    });
    expect(plistNotOurs(amp, "local.ttasks.service")).toBeUndefined();
    expect(readPlist(amp)).toMatchObject({ kind: "dict" });
  });

  test("a unit, plist or Run value holding text install never writes is someone else's: a control character, a misplaced byte order mark, a size systemd would not load, an unknown section", () => {
    const ours = golden("ttasks.service");
    // Round 3's probe: systemd ends a line at NUL, so this adds an ExecStartPre= that a reader
    // splitting at line feeds only took for part of a comment.
    expect(unitNotOurs(`${ours}# comment\u0000[Service]\u0000ExecStartPre=/usr/bin/other\n`)).toBe(
      "unusual_text",
    );
    // Every control character install never writes (it writes only the line feed), C1 included.
    for (const c of ["\u0000", "\r", "\t", "\f", "\v", "\u001b", "\u007f", "\u0085", "\u009f"]) {
      expect(unitNotOurs(ours.replace("RestartSec=2", `RestartSec=2${c}`))).toBe("unusual_text");
    }
    // CRLF: systemd reads it, and `\n\r` as one line end too; install writes neither.
    expect(unitNotOurs(ours.replaceAll("\n", "\r\n"))).toBe("unusual_text");
    // A byte order mark only at the very start, where systemd skips it.
    expect(unitNotOurs(`\uFEFF${ours}`)).toBeUndefined();
    expect(unitNotOurs(ours.replace("[Service]", "\uFEFF[Service]"))).toBe("unusual_text");
    // Text that is not well formed, and more than any unit install writes (systemd refuses a line
    // over 1 MiB; nothing that size is read at all).
    expect(unitNotOurs(`${ours}# \uD800\n`)).toBe("unusual_text");
    expect(unitNotOurs(`${ours}# ${"x".repeat(70_000)}\n`)).toBe("unusual_text");
    // A last line without a line feed is read as systemd reads it.
    expect(unitNotOurs(ours.trimEnd())).toBeUndefined();
    expect(unitNotOurs(`${ours.trimEnd()}\nExecStartPre=/usr/bin/other`)).toBe("other_settings");
    // A section install does not write, even an empty one.
    expect(unitNotOurs(`${ours}[Timer]\n`)).toBe("other_settings");
    expect(unitNotOurs(`${ours}[X-Other]\n`)).toBe("other_settings");
    // In ExecStart= a backslash, an apostrophe or a specifier other than %% is something install
    // never writes there, and systemd would read a path other than the one these words spell.
    for (const exec of [
      "/opt/x\\x20/ttasks serve",
      "/opt/%h/ttasks serve",
      "'/opt/x/ttasks' serve",
      "/opt/x/tasks se\\rve",
    ]) {
      expect(unitNotOurs(ours.replace(/^ExecStart=.*$/m, `ExecStart=${exec}`))).toBe("not_ours");
    }
    expect(unitNotOurs(ours.replace(/^ExecStart=.*$/m, 'ExecStart="/opt/1%%/ttasks" serve'))).toBe(
      undefined,
    );
    // A plist and a Run value the same way.
    const plist = golden("local.ttasks.service.plist");
    const label = "local.ttasks.service";
    expect(plistNotOurs(`${plist}\u0000`, label)).toBe("unusual_text");
    expect(plistNotOurs(plist.replaceAll("\n", "\r\n"), label)).toBe("unusual_text");
    expect(plistNotOurs(plist.replace("<dict>", "<dict>\t"), label)).toBe("unusual_text");
    expect(plistNotOurs(`\uFEFF${plist}`, label)).toBe("unusual_text");
    expect(runDataNotOurs('"C:\\Users\\mira\\.local\\bin\\ttasksw.exe"')).toBeUndefined();
    expect(runDataNotOurs('"C:\\x\\ttasksw.exe"\u0000 --other')).toBe("unusual_text");
    expect(runDataNotOurs('"C:\\x\\ttasksw.exe"\r\n')).toBe("unusual_text");
    expect(runDataNotOurs(' "C:\\x\\ttasksw.exe"')).toBe("not_ours");
  });

  test("Task Manager's StartupApproved record: an odd first byte is off, an even one on, none is not set", () => {
    expect(startupApproved(Uint8Array.from([3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe("off");
    expect(startupApproved(Uint8Array.from([7, 0, 0, 0]))).toBe("off");
    expect(startupApproved(Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("on");
    expect(startupApproved(Uint8Array.from([6, 0, 0, 0]))).toBe("on");
    expect(startupApproved(undefined)).toBe("not_set");
    expect(startupApproved(new Uint8Array(0))).toBe("not_set");
  });

  test("the ttasks-launchd wrapper is A2 3.3.4's script with its three additions", () => {
    const lines = LAUNCHD_WRAPPER.split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(LAUNCHD_WRAPPER).toContain("ttasks=${0%/*}/ttasks");
    expect(LAUNCHD_WRAPPER).toContain("0|64|73) exit 0 ;;");
    expect(LAUNCHD_WRAPPER).toContain('*) exit "$code" ;;');
    expect(LAUNCHD_WRAPPER.endsWith("exit 0\n")).toBe(true);
  });
});
