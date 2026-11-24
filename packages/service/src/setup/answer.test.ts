// What a home's row says and offers, from the answers of its settings files (homeAnswer), and the
// per-file facts the review of the one-file answer turned on (toolsAnswer).
import { describe, expect, test } from "vitest";
import {
  homeAnswer,
  toolsAnswer,
  type HomeAnswer,
  type ToolsAnswer,
  type ToolsFacts,
} from "./answer.ts";

const on: ToolsAnswer = { status: "on", off: true };
const unknown: ToolsAnswer = { status: "unknown", off: true };
const offLive = (why: ToolsAnswer["why"], turn?: ToolsAnswer["on"]): ToolsAnswer => ({
  status: "off",
  ...(why === undefined ? {} : { why }),
  ...(turn === undefined ? {} : { on: turn }),
  off: true,
});
const offOff = (why: ToolsAnswer["why"], turn?: ToolsAnswer["on"]): ToolsAnswer => ({
  status: "off",
  ...(why === undefined ? {} : { why }),
  ...(turn === undefined ? {} : { on: turn }),
  off: false,
});

const PLAIN = "~/.claude.json";
const INNER = "~/.claude/.claude.json";

/** Per-file answers in, the row out. */
const TABLE: readonly [string, readonly ToolsAnswer[], HomeAnswer][] = [
  ["one file, on", [on], { status: "on", files: [], off: true }],
  [
    "one file, off, its entry gone",
    [offLive("missing", "repair")],
    { status: "off", files: [{ file: PLAIN, why: "missing", on: "repair" }], off: true },
  ],
  ["both on", [on, on], { status: "on", files: [], off: true }],
  [
    "one on, the other without its entry yet: on, and the other offers Add",
    [on, offLive("missing", "add")],
    { status: "on", files: [{ file: INNER, why: "missing", on: "add" }], off: true },
  ],
  [
    "the first cannot be read, the second works: on, the first named",
    [offLive("invalid_file"), on],
    { status: "on", files: [{ file: PLAIN, why: "invalid_file" }], off: true },
  ],
  [
    "an older install in one, this one in the other: on, with the repair offered",
    [{ status: "on", why: "older", on: "repair", off: true }, on],
    { status: "on", files: [{ file: PLAIN, why: "older", on: "repair" }], off: true },
  ],
  [
    "neither starts: off, each named with its own reason",
    [offLive("not_installed"), offLive("unbound")],
    {
      status: "off",
      files: [
        { file: PLAIN, why: "not_installed" },
        { file: INNER, why: "unbound" },
      ],
      off: true,
    },
  ],
  [
    "the access off: each file offers it back, and Off finishes what is recorded",
    [
      { status: "off", why: "access_off", on: "grant", off: true },
      { status: "off", why: "access_off", on: "grant", off: true },
    ],
    {
      status: "off",
      files: [
        { file: PLAIN, why: "access_off", on: "grant" },
        { file: INNER, why: "access_off", on: "grant" },
      ],
      off: true,
    },
  ],
  [
    "nothing set up: Add for each, nothing to turn off",
    [offOff(undefined, "add"), offOff(undefined, "add")],
    {
      status: "off",
      files: [
        { file: PLAIN, on: "add" },
        { file: INNER, on: "add" },
      ],
      off: false,
    },
  ],
  [
    "the access not known: unknown when an entry would start, Off kept",
    [unknown, offLive(undefined)],
    { status: "unknown", files: [], off: true },
  ],
  [
    "one off with a person's entry, the other on: on",
    [offOff("foreign_entry"), on],
    { status: "on", files: [{ file: PLAIN, why: "foreign_entry" }], off: true },
  ],
];

describe("[A3.3.13.setup.home-answer] A home's row from its files' answers: on when one file's tools start, each file's need said as its own, Off as any file offers it", () => {
  test.each(TABLE.map(([name, files, row]) => [name, files, row] as const))(
    "%s",
    (_name, files, row) => {
      const named = files.map((answer, i) => ({ file: i === 0 ? PLAIN : INNER, answer }));
      expect(homeAnswer(named)).toEqual(row);
    },
  );

  const base: ToolsFacts = {
    state: "registered",
    entry: true,
    program: "there",
    binds: true,
    access: "live",
    otherSpace: false,
    writable: true,
    installed: true,
    handMade: false,
    owned: true,
  };

  test("a file's tools are on only when its entry will start: its program there, naming the home's instance and space", () => {
    expect(toolsAnswer(base)).toEqual({ status: "on", off: true });
    expect(toolsAnswer({ ...base, binds: false })).toEqual(offLive("unbound"));
    // An entry with no command: no program to name.
    const noProgram: ToolsFacts = {
      state: "edited",
      entry: true,
      binds: true,
      access: "live",
      otherSpace: false,
      writable: true,
      installed: true,
      handMade: false,
      owned: false,
    };
    expect(toolsAnswer(noProgram)).toEqual(offLive("no_program"));
    expect(
      toolsAnswer({
        ...base,
        state: "refused",
        refusal: "foreign_entry",
        program: "gone",
        owned: false,
      }),
    ).toEqual(offLive("foreign_entry"));
    expect(
      toolsAnswer({
        ...base,
        state: "refused",
        refusal: "invalid_file",
        entry: false,
        owned: false,
      }),
    ).toEqual(offLive("invalid_file"));
  });

  test("a working older install is on, with the repair offered; the access off, it is offered back and Off stays offered for setup's entry", () => {
    expect(toolsAnswer({ ...base, program: "older" })).toEqual({
      status: "on",
      why: "older",
      on: "repair",
      off: true,
    });
    expect(toolsAnswer({ ...base, access: "off" })).toEqual({
      status: "off",
      why: "access_off",
      on: "grant",
      off: true,
    });
  });

  test("while no service says whether the access is live, nothing is offered to turn on", () => {
    for (const facts of [
      { ...base, access: "unknown" as const, state: "not_registered" as const, entry: false },
      { ...base, access: "unknown" as const, program: "moved" as const },
      { ...base, access: "unknown" as const, program: "older" as const },
    ]) {
      expect(toolsAnswer(facts).on).toBeUndefined();
    }
  });

  test("a file with no entry in a home set up in another space is not offered from here", () => {
    expect(
      toolsAnswer({
        ...base,
        state: "not_registered",
        entry: false,
        owned: false,
        otherSpace: true,
      }),
    ).toEqual(offLive("other_space"));
  });
});
