// `ttasks skills` from the files alone: the list a person reads, and a copy to start from that
// never replaces their own.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main, type Io } from "./main.ts";
import { render } from "./output.ts";

function recorder(argv: readonly string[], home: string) {
  const io = {
    argv,
    env: { TTASKS_HOME: home },
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

const run = async (home: string, ...argv: string[]) => {
  const io = recorder(argv, home);
  return { code: await main(io), out: io.out, err: io.err };
};

describe("[A3.3.6.mcp.skills] ttasks skills", () => {
  test("copy writes a default to start from and never replaces the user's file; the list says what each is", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const file = join(home, "skills", "sizing-effort", "SKILL.md");
      expect((await run(home, "skills", "copy", "sizing-effort")).code).toBe(0);
      expect(readFileSync(file, "utf8")).toMatch(/^---\nname: sizing-effort\n/u);
      writeFileSync(file, "My own sizing.\n");
      const again = await run(home, "skills", "copy", "sizing-effort");
      expect(again.code).toBe(0);
      expect(again.out).toContain("kept as it is");
      expect(readFileSync(file, "utf8")).toBe("My own sizing.\n");
      expect((await run(home, "skills", "copy", "no-default")).code).toBe(2);

      mkdirSync(join(home, "skills", "huge"));
      writeFileSync(join(home, "skills", "huge", "SKILL.md"), "z".repeat(17 * 1024));
      const listed = JSON.parse((await run(home, "--json", "skills")).out) as {
        skills: { name: string; origin: string; problem?: string }[];
      };
      const by = new Map(listed.skills.map((skill) => [skill.name, skill]));
      expect(by.get("sizing-effort")?.origin).toBe("edited");
      expect(by.get("organizing")?.origin).toBe("default");
      expect(by.get("huge")?.origin).toBe("own");
      expect(by.get("huge")?.problem).toContain("16 KB");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a default that changed since the user's copy is marked, and diff shows what changed in it", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const file = join(home, "skills", "sizing-effort", "SKILL.md");
      // What `copy` keeps of the default it copied: the default as an older build shipped it.
      const madeFrom = join(home, "skills", ".copied-from", "sizing-effort.md");
      expect((await run(home, "skills", "copy", "sizing-effort")).code).toBe(0);
      const today = readFileSync(file, "utf8");
      const state = async () =>
        (
          JSON.parse((await run(home, "--json", "skills")).out) as {
            skills: { name: string; default_since_copy?: string }[];
          }
        ).skills.find((skill) => skill.name === "sizing-effort")?.default_since_copy;
      expect(await state()).toBe("same");
      expect((await run(home, "skills", "diff", "sizing-effort")).out).toContain("has not changed");

      const older = today.replace(
        "# Sizing effort",
        "# Sizing effort\n\nAn example that was dropped since.",
      );
      writeFileSync(madeFrom, older);
      writeFileSync(file, `${older}\nThe user's own rule.\n`);
      expect(await state()).toBe("changed");
      expect((await run(home, "skills")).out).toContain("skills diff sizing-effort");
      const shown = await run(home, "skills", "diff", "sizing-effort");
      expect(shown.code).toBe(0);
      expect(shown.out).toContain("- An example that was dropped since.");
      // The difference is the default's own, not the user's edit, and unchanged lines are left out.
      expect(shown.out).not.toContain("The user's own rule.");
      expect(shown.out).toContain("...");
      expect(shown.out).toContain(file);

      // copy over an edited copy keeps it, and counts it as made from today's default.
      expect((await run(home, "skills", "copy", "sizing-effort")).out).toContain("kept as it is");
      expect(readFileSync(file, "utf8")).toBe(`${older}\nThe user's own rule.\n`);
      expect(await state()).toBe("same");

      // A copy made by hand: no record of its default, so diff compares it with today's.
      rmSync(madeFrom);
      writeFileSync(file, "A copy written by hand.\n");
      expect(await state()).toBe("unknown");
      const unknown = await run(home, "skills", "diff", "sizing-effort");
      expect(unknown.out).toContain("- A copy written by hand.");
      expect(unknown.out).toContain("+ name: sizing-effort");

      expect((await run(home, "skills", "diff", "organizing")).out).toContain("no copy");
      expect((await run(home, "skills", "diff", "no-default")).code).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("copy over a file of the user's keeps its bytes, whatever the record of its default says", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const file = join(home, "skills", "sizing-effort", "SKILL.md");
      const madeFrom = join(home, "skills", ".copied-from", "sizing-effort.md");
      expect((await run(home, "skills", "copy", "sizing-effort")).code).toBe(0);
      const today = readFileSync(file, "utf8");
      const older = today.replace(
        "# Sizing effort",
        "# Sizing effort\n\nAn example that was dropped since.",
      );
      const edited = `${older}\nThe user's own rule.\n`;
      const cases: { name: string; file: string; record: string | undefined }[] = [
        { name: "an edited copy", file: edited, record: older },
        {
          name: "a copy with only its line ends changed",
          file: older.replaceAll("\n", "\r\n"),
          record: older,
        },
        { name: "a copy with no record", file: older, record: undefined },
        { name: "a damaged record", file: edited, record: String.fromCharCode(0, 0xff) },
        { name: "a record that is the user's own file", file: edited, record: edited },
        { name: "a copy as the older default left it", file: older, record: older },
      ];
      for (const given of cases) {
        writeFileSync(file, given.file);
        if (given.record === undefined) rmSync(madeFrom, { force: true });
        else writeFileSync(madeFrom, given.record);
        const copied = await run(home, "--json", "skills", "copy", "sizing-effort");
        expect(copied.code, given.name).toBe(0);
        expect(JSON.parse(copied.out), given.name).toMatchObject({ written: false });
        expect(readFileSync(file).equals(Buffer.from(given.file)), given.name).toBe(true);
        expect(readFileSync(madeFrom, "utf8"), given.name).toBe(today);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a linked record folder is no record: diff compares the copy with today's default", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const file = join(home, "skills", "sizing-effort", "SKILL.md");
      expect((await run(home, "skills", "copy", "sizing-effort")).code).toBe(0);
      writeFileSync(file, `${readFileSync(file, "utf8")}A rule of the user's.\n`);
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "sizing-effort.md"), "Text from outside the skills folder.\n");
      rmSync(join(home, "skills", ".copied-from"), { recursive: true });
      symlinkSync(elsewhere, join(home, "skills", ".copied-from"), "junction");

      const listed = JSON.parse((await run(home, "--json", "skills")).out) as {
        skills: { name: string; default_since_copy?: string }[];
      };
      const sizing = listed.skills.find((skill) => skill.name === "sizing-effort");
      expect(sizing?.default_since_copy).toBe("unknown");
      const shown = await run(home, "skills", "diff", "sizing-effort");
      expect(shown.out).toContain("- A rule of the user's.");
      expect(shown.out).not.toContain("Text from outside");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("diff reads a copy saved as UTF-16 as agents get it", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const file = join(home, "skills", "sizing-effort", "SKILL.md");
      expect((await run(home, "skills", "copy", "sizing-effort")).code).toBe(0);
      const today = readFileSync(file, "utf8");
      rmSync(join(home, "skills", ".copied-from", "sizing-effort.md"));
      // Windows PowerShell 5 saves UTF-16 with a byte order mark.
      const text = Buffer.from(
        `${today}A rule of the user's.\n`.replaceAll("\n", "\r\n"),
        "utf16le",
      );
      writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), text]));

      const shown = await run(home, "skills", "diff", "sizing-effort");
      expect(shown.out).toContain("- A rule of the user's.");
      // Only the user's line differs: the rest decodes to today's default.
      expect(shown.out.split("\n").filter((line) => /^[-+] /u.test(line))).toEqual([
        "- A rule of the user's.",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("copy writes into no linked folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "tt-skills-"));
    try {
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(home, "skills"), "junction");
      const copied = await run(home, "skills", "copy", "sizing-effort");
      expect(copied.code).toBe(2);
      expect(copied.err).toContain("is a link");
      expect(existsSync(join(elsewhere, "sizing-effort"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("show prints why a skill of the user's own cannot be used", () => {
    const text = render(
      "space.status",
      {
        space: { name: "Check", ref_prefix: "C" },
        date: "2026-11-23",
        counts: { statuses: [], inbox: 0 },
        skills: [{ name: "huge", problem: "The user's file cannot be used: it is 17 KB." }],
      },
      "Check",
    );
    expect(text).toContain("huge: The user's file cannot be used: it is 17 KB.");
  });
});
