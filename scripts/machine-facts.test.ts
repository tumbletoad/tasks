import { describe, expect, test } from "vitest";
import { explain, findMachineFacts, scanRepository } from "./machine-facts.ts";
import { repoRoot } from "./run.ts";

const found = (text: string) => findMachineFacts("x.md", text).map((f) => f.found);

describe("[A7.3.3.no-machine-facts] no facts about a person's machines in the repository", () => {
  test("no file in the repository describes a person's own machines", () => {
    const findings = scanRepository(repoRoot);
    expect(findings.map(explain)).toEqual([]);
  });

  test.each([
    ["a machine's role", "Measured on the Windows reference machine.", "reference machine"],
    ["a lab machine", "Run it on the Linux lab machine first.", "lab machine"],
    ["a named test machine", "Copy the archive to the test machine.", "the test machine"],
    ["the owner's machine", "Signed by hand on the owner's machine.", "owner's machine"],
    [
      "the maintainer's machine",
      "It ran on the maintainer’s own computer.",
      "maintainer’s own computer",
    ],
    ["the laptop", "The Linux check runs on the laptop.", "the laptop"],
    ["the desktop as a computer", "One full run on the desktop at a time.", "on the desktop"],
    ["a desktop-only refusal", "The lab is desktop-only.", "desktop-only"],
    ["a home's folders", "The checkout is in ~/Dev/Tools/tasks.", "~/Dev/"],
    ["a real Linux home", "Logs go to /home/kim/x.", "/home/kim"],
    ["a real macOS home", "See /Users/kim/x.", "/Users/kim"],
    ["a real Windows home", 'path = "C:\\\\Users\\\\Kim\\\\x"', "C:\\\\Users\\\\Kim"],
    [
      "a scratch folder under a profile",
      "--scratch %USERPROFILE%\\tasks-test\\x",
      "%USERPROFILE%\\tasks-test",
    ],
    ["a lab scratch folder", "under /s/tasks-test/m0-09", "tasks-test/m0-"],
    ["an OS build number", "Seen on Windows 11 build 26300.", "Windows 11 build 26300"],
    ["an OS version with its build", "OS 10.0.26300 only.", "10.0.26300"],
  ])("finds %s", (_kind, text, phrase) => {
    expect(found(text)).toEqual([phrase]);
  });

  test("finds a phrase split over a line break and a comment marker, at its first line", () => {
    for (const marker of ["//", " *", "#", ">"]) {
      const text = `${marker} first\n${marker} Measured on the Windows reference\n${marker} machine, twice.\n`;
      expect(findMachineFacts("x", text).map((f) => [f.found, f.line])).toEqual([
        ["reference machine", 2],
      ]);
    }
    expect(found("Run it on the\n  // laptop.")).toEqual(["the laptop"]);
  });

  test("lets product language about the desktop pass", () => {
    expect(
      found(
        [
          "Terminals open in Ghostty: the desktop's default.",
          "The desktop session's variables, then the desktop entry with this ID.",
          "What a program started from the desktop has. A desktop's list is read only on that desktop.",
          "The desktop app is closed. Widths: desktop and laptop layouts.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("lets fixture homes, placeholders and product folders pass", () => {
    expect(
      found(
        [
          "/home/mira/work, /Users/mira, C:\\Users\\mira, C:\\\\Users\\\\Mïra, c:\\users\\m\\x",
          "/home/<user>/x, C:\\Users\\<user>\\x, /home/$USER, /home/x, /home/fixture-builder",
          "C:\\Users\\RUNNER~1\\x, /home/runner/work, C:\\Users\\you\\tasks-test, /Volumes/home/kim",
          "%USERPROFILE%\\.tasks-test, $HOME/tasks-smoke, /home/mira/tasks-test, build 2, 10.0.19",
          "The owner signs a release. A machine named mira-laptop.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a finding says where it is and what to write instead", () => {
    expect(findMachineFacts("docs/a.md", "x\nOn the laptop.").map(explain)).toEqual([
      'docs/a.md:2: "the laptop". Name the platform instead: "on Windows 11", "on Ubuntu 24.04".',
    ]);
  });
});
