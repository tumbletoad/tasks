// Exit codes and output (A2 3.10.2, 3.10.3; A3 3.5): every error code exits with its class's code,
// --json prints exactly one document, people's text names the space of every write, diagnostics
// go to stderr. Fixture text only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import {
  ERROR_CODES,
  EXIT_CODES,
  messageWithHint,
  outputJsonSchema,
  registry,
  type ErrorCode,
} from "@ttasks/contracts";
import { RpcError, LocalError } from "@ttasks/bridge/protocol";
import { SLOTS, main, type Io } from "./main.ts";
import { bodyOf, exitCodeOf, printError, render } from "./output.ts";
import { asAppError } from "./verbs.ts";

function recorder(
  argv: readonly string[] = [],
  env: Record<string, string> = {},
  stdin = "",
): Io & { out: string; err: string } {
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
    readStdin: () => Promise.resolve(stdin),
    readFile: () => Promise.reject(new Error("no file")),
  };
  return io;
}

describe("[A2.3.10.cli.exit-codes] exit codes and output", () => {
  test("every error code exits with its class's code (A2 3.10.3)", () => {
    const expected: Record<string, number> = {
      invalid_input: 2,
      not_found: 3,
      ambiguous: 3,
      unbound: 9,
      launch_unknown: 3,
      conflict: 4,
      wrong_tool: 2,
      forbidden: 5,
      not_permitted: 5,
      request_id_conflict: 4,
      applied_earlier: 4,
      too_large: 2,
      cursor_expired: 3,
      space_unavailable: 8,
      service_unavailable: 6,
      read_only: 8,
      op_unknown: 7,
      internal: 1,
    };
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      expect(exitCodeOf({ code, message: "x" }), code).toBe(expected[code]);
    }
    for (const reason of ["restart_session", "service_too_old"]) {
      expect(exitCodeOf({ code: "service_unavailable", message: "x", data: { reason } })).toBe(
        EXIT_CODES.version,
      );
    }
    for (const reason of [
      "not_running",
      "unreachable",
      "untrusted_endpoint",
      "connection_lost",
      "starting",
    ]) {
      expect(exitCodeOf({ code: "service_unavailable", message: "x", data: { reason } })).toBe(
        EXIT_CODES.service,
      );
    }
  });

  test("transport and protocol failures become A3's bodies", () => {
    expect(bodyOf(asAppError(new LocalError("service_too_old", "refused")))).toMatchObject({
      code: "service_unavailable",
      data: { reason: "service_too_old", retryable: false },
    });
    expect(bodyOf(new RpcError(-32000, "x", { code: "conflict", message: "Read again." }))).toEqual(
      {
        code: "conflict",
        message: "Read again.",
      },
    );
    expect(bodyOf(new RpcError(-32601, "Method not found")).code).toBe("op_unknown");
    expect(bodyOf(new Error("Fixture secret text"))).toEqual({
      code: "internal",
      message: "Something went wrong.",
      hint: "Run: ttasks doctor",
    });
  });

  test("--json prints one document on stdout, with the class; text goes to stderr", () => {
    const json = recorder();
    expect(
      printError(json, true, {
        code: "conflict",
        message: "Read again.",
        data: { cause: "VERSION_CONFLICT" },
      }),
    ).toBe(4);
    expect(JSON.parse(json.out)).toEqual({
      error: {
        code: "conflict",
        class: "conflict",
        message: "Read again.",
        data: { cause: "VERSION_CONFLICT" },
      },
    });
    expect(json.err).toBe("");
    const text = recorder();
    printError(text, false, { code: "not_found", message: "No task.", hint: "Check it." });
    expect(text.out).toBe("");
    expect(text.err).toBe("error not_found: No task. Check it.\n");
  });

  test("ttasks brief prints the pointer brief, ready to paste, or how its launch stands", () => {
    const launch = { reference: "L7KQ21", state: "dispatched" };
    expect(render("launch.open", { launch, copy: "TTasks task M-14\nFolder: x" }, "Mira")).toBe(
      "TTasks task M-14\nFolder: x\n",
    );
    expect(render("launch.open", { launch: { ...launch, state: "prepared" } }, "Mira")).toBe(
      "Launch L7KQ21: prepared\n",
    );
    // An Open that could not carry what its instance sets says what it left out.
    expect(
      render(
        "launch.open",
        { launch: { ...launch, left_out: ["read-only", "environment"] } },
        "Mira",
      ),
    ).toBe(
      `Launch L7KQ21: dispatched\nOpened without your read-only setting and your environment variables, which this way of opening cannot carry. A terminal can, where one is set up: see ${CLI_NAME} doctor.\n`,
    );
  });

  test("people's text names the space of every write", () => {
    expect(render("task.add", { tasks: [{ ref: "M-31" }] }, "Mira")).toBe("Added M-31 to Mira\n");
    // A draft found by its source key (A3 3.4.5) says so, never "Added".
    const found = { result: "exists", ref: "M-14", lifecycle: "active", log_added: true };
    expect(
      render(
        "task.add",
        {
          tasks: [
            found,
            { ...found, lifecycle: "completed", log_added: false, log_left_out: true },
            {
              result: "exists",
              ambiguous: ["M-14", "M-15"],
              log_added: false,
              log_left_out: true,
            },
            { ...found, log_added: false },
          ],
        },
        "Mira",
      ),
    ).toBe(
      "Found M-14 in Mira by its source key, log entry added\n" +
        "Found M-14 (completed) in Mira by its source key; this command added its log entry to no task: look at it first, as it may have it already, then add it with ttasks log\n" +
        "Several tasks in Mira have its source key: M-14, M-15; this command added its log entry to no task: look at them first, as one may have it already, then add it with ttasks log\n" +
        "Found M-14 in Mira by its source key\n",
    );
    // A follow-up found by its source key says the same of the follow-up.
    expect(
      render(
        "task.finish",
        {
          result: "completed",
          task: "M-9",
          lifecycle: "completed",
          follow_ups: [
            { result: "created", ref: "M-31" },
            {
              result: "exists",
              ambiguous: ["M-14", "M-15"],
              log_added: false,
              log_left_out: true,
            },
          ],
        },
        "Mira",
      ),
    ).toBe(
      "Completed M-9 in Mira\n" +
        "Added M-31 to Mira\n" +
        "Several tasks in Mira have a follow-up's source key: M-14, M-15; this command added a follow-up's log entry to no task: look at them first, as one may have it already, then add it with ttasks log\n",
    );
    expect(
      render("task.update", { result: "updated", task: "M-14", fields: ["summary"] }, "Mira"),
    ).toBe("Updated M-14 in Mira: summary\n");
    expect(
      render("entry.add", { kind: "evidence", entry: "l3", task: "M-14", replayed: true }, "Mira"),
    ).toBe("Logged l3 on M-14 in Mira (replayed)\n");
    // A warning is part of what happened, so a person reads it too.
    expect(
      render("task.add", { tasks: [{ ref: "M-31" }], warnings: ["Made 1 new area."] }, "Mira"),
    ).toBe("Added M-31 to Mira\nWarning: Made 1 new area.\n");
  });

  test("a new task's source whose key another task holds says which task holds it", () => {
    const added = render(
      "task.add",
      { tasks: [{ result: "created", ref: "M-32", held: [{ source: 1, held_by: "M-14" }] }] },
      "Mira",
    );
    expect(added).toContain("Added M-32 to Mira");
    expect(added).toContain("M-14");
    const finished = render(
      "task.finish",
      {
        result: "completed",
        task: "M-9",
        lifecycle: "completed",
        follow_ups: [{ result: "created", ref: "M-33", held: [{ source: 0, held_by: "M-15" }] }],
      },
      "Mira",
    );
    expect(finished).toContain("M-15");
  });

  test("a task shows the one state a person says, and no as-of token", () => {
    const shown = (lifecycle: string) =>
      render(
        "task.get",
        {
          as_of: "1.1046.5n0w8k3q",
          task: { ref: "M-25", title: "Fixture task", status: "open", priority: 2, lifecycle },
        },
        "Mira",
      );
    expect(shown("completed")).toBe("M-25  Fixture task  (completed, p2)\n");
    expect(shown("archived")).toBe("M-25  Fixture task  (dropped, p2)\n");
    expect(shown("active")).toBe("M-25  Fixture task  (open, p2)\n");
  });

  test("a launch's request and every line of an entry stay inside their entry, whatever breaks the line", () => {
    const separator = String.fromCharCode(0x2028);
    const shown = render(
      "task.get",
      {
        as_of: "1.1046.5n0w8k3q",
        request: {
          note: "n2",
          text: `Check the booking.\r\nCancel the duplicate.${separator}Then say so.`,
        },
        task: { ref: "M-25", title: "Fixture task", status: "open", priority: 2 },
        sections: {
          instructions: [{ ref: "n1", text: "Keep it short.\nUse the form." }],
          notes: [
            {
              ref: "n2",
              author: "user",
              text: `Check the booking.\r\nCancel the duplicate.${separator}Then say so.`,
              request_for: [{ launch: "L7KQ21", instance: "claude-work" }],
            },
          ],
          log: [{ ref: "l1", kind: "progress", author: "Claude", text: "Read it.\rStarted." }],
        },
      },
      "Mira",
    );
    const lines = shown.trimEnd().split("\n");
    // Only the task's line and the request's heading start at the margin.
    expect(lines.filter((line) => !line.startsWith("  "))).toEqual([
      "M-25  Fixture task  (open, p2)",
      "Request from the user for this launch:",
    ]);
    expect(lines.slice(1, 5)).toEqual([
      "Request from the user for this launch:",
      "  Check the booking.",
      "  Cancel the duplicate.",
      "  Then say so.",
    ]);
    expect(shown).toContain(
      "  n2 user (request for launch L7KQ21 [claude-work]): Check the booking.\n    Cancel the duplicate.\n    Then say so.",
    );
    expect(shown).not.toContain("\r");
    expect(shown).not.toContain(separator);
  });

  test("a task's learnings: the digest's first ones and their count, the outcome section's all", () => {
    const task = { ref: "M-25", title: "Fixture task", status: "open", priority: 2 };
    const digest = (learnings: string[], more: number) =>
      render(
        "task.get",
        { as_of: "1.1046.5n0w8k3q", task: { ...task, learnings, more: { learnings: more } } },
        "Mira",
      );
    expect(digest(["Book early.", "Ask twice."], 0)).toBe(
      "M-25  Fixture task  (open, p2)\n  learnings: 2 of 2\n  learning: Book early.\n  learning: Ask twice.\n",
    );
    expect(digest([], 3)).toBe(
      "M-25  Fixture task  (open, p2)\n  learnings: 0 of 3, all with --section outcome\n",
    );
    expect(digest([], 0)).toBe("M-25  Fixture task  (open, p2)\n");
    const section = render(
      "task.get",
      {
        as_of: "1.1046.5n0w8k3q",
        task,
        sections: {
          outcome: {
            outcome: "Booked.",
            wrap_state: "wrapped",
            learnings: ["Book early.", "Ask twice."],
          },
        },
      },
      "Mira",
    );
    expect(section).toBe(
      "M-25  Fixture task  (open, p2)\n  outcome (wrapped): Booked.\n  learning: Book early.\n  learning: Ask twice.\n",
    );
  });

  test("a task's folder says whose it is and when it is not on this machine", () => {
    const folderLine = (folder: Record<string, unknown>) =>
      render(
        "task.get",
        {
          as_of: "1.1046.5n0w8k3q",
          task: { ref: "M-25", title: "Fixture task", status: "open", priority: 2, folder },
        },
        "Mira",
      ).split("\n")[1];
    expect(folderLine({ path: "~/work/portal", of: "task" })).toBe("  folder: ~/work/portal");
    expect(folderLine({ path: "~/work/portal", of: "project" })).toBe(
      "  folder: ~/work/portal (its project's)",
    );
    expect(folderLine({ path: "~/work/portal", of: "task", missing: true })).toBe(
      "  folder: ~/work/portal (not found on this machine)",
    );
    expect(folderLine({ path: "~/work/portal", of: "project", missing: true })).toBe(
      "  folder: ~/work/portal (its project's, not found on this machine)",
    );
    expect(folderLine({ machine: "mira-laptop" })).toBe("  folder: on mira-laptop");
  });

  test("a source's line says where captures of it go, and how many more tasks there are", () => {
    const line = (source: Record<string, unknown>) =>
      render(
        "task.get",
        {
          as_of: "1.1046.5n0w8k3q",
          task: { ref: "M-25", title: "Fixture task", status: "open", priority: 2 },
          sections: { sources: [{ id: "s_1", kind: "ticket", title: "Fixture", ...source }] },
        },
        "Mira",
      ).split("\n")[1];
    expect(line({ ref: "fix:1", captures_to: ["M-2"] })).toBe(
      "  source: Fixture [fix:1 · captures go to M-2 · s_1]",
    );
    expect(line({ ref: "fix:1", captures_to: ["M-2", "M-3"], captures_more: 4 })).toBe(
      "  source: Fixture [fix:1 · captures ask which of M-2, M-3 and 4 more · s_1]",
    );
  });

  test("no service: exit 6 with A2 3.3.6's message, and tasks alone still answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "kc-"));
    try {
      const json = recorder(["status", "--json"], { TTASKS_HOME: home });
      expect(await main(json)).toBe(6);
      expect(JSON.parse(json.out)).toMatchObject({
        error: {
          code: "service_unavailable",
          class: "service",
          hint: "ttasks service start",
          data: { reason: "not_running" },
        },
      });
      const text = recorder(["status"], { TTASKS_HOME: home });
      expect(await main(text)).toBe(6);
      // The message and its hint, each said once (A3 3.5).
      expect(text.err).toBe(
        "error service_unavailable: TTasks's service is not running. Run: ttasks service start\n",
      );
      const bare = recorder([], { TTASKS_HOME: home });
      expect(await main(bare)).toBe(0);
      expect(bare.out).toContain("not running");
      const unknown = recorder(["frobnicate"], { TTASKS_HOME: home });
      expect(await main(unknown)).toBe(2);
      // A slot no step has filled yet is a usage error. `mcp` is filled (the bridge, mcp.test.ts).
      for (const [name, command] of Object.entries(SLOTS)) {
        if (command !== undefined) continue;
        const slot = recorder([name], { TTASKS_HOME: home });
        expect(await main(slot), name).toBe(2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("usage errors stay usage errors, as one JSON document, whatever --input holds", async () => {
    const home = mkdtempSync(join(tmpdir(), "kc-"));
    const run = async (argv: string[], stdin = "") => {
      const io = recorder(argv, { TTASKS_HOME: home }, stdin);
      const code = await main(io);
      return { code, out: io.out, err: io.err };
    };
    const usage = { error: { code: "invalid_input", class: "usage" } };
    try {
      // stdin is read once: `--input -` and a text argument `-` cannot both read it.
      const twice = await run(
        ["add", "-", "--input", "-", "--json"],
        JSON.stringify({ tasks: [{ title: "Fixture title" }] }),
      );
      expect(twice.code).toBe(2);
      expect(JSON.parse(twice.out)).toMatchObject(usage);

      // A request ID from --input is checked as --request-id is, and never printed.
      const forged = await run(
        ["log", "M-1", "Fixture entry", "--input", "-", "--json"],
        JSON.stringify({ request_id: "Fixture secret text\nFORGED DIAGNOSTIC" }),
      );
      expect(forged.code).toBe(2);
      expect(JSON.parse(forged.out)).toMatchObject(usage);
      expect(forged.out + forged.err).not.toContain("Fixture secret");

      // A field of --input that is not the object or list an argument needs.
      for (const [argv, input] of [
        [["set", "M-1", "summary=Fixture"], { set: "bad" }],
        [["add", "Fixture"], { tasks: "bad" }],
        [["add", "Fixture"], { tasks: ["bad"] }],
        [["set", "M-1", "--clear", "due"], { clear: "bad" }],
      ] as const) {
        const ran = await run([...argv, "--input", "-", "--json"], JSON.stringify(input));
        expect(ran.code, argv.join(" ")).toBe(2);
        expect(JSON.parse(ran.out)).toMatchObject(usage);
      }

      // doctor's usage error is one JSON document too.
      const doctor = await run(["doctor", "--frobnicate", "--json"]);
      expect(doctor.code).toBe(2);
      expect(JSON.parse(doctor.out)).toMatchObject(usage);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("[A3.5.search.find] ttasks find prints a search page", () => {
  test("a header, task and learning rows, placeholders, the changed marker and the next page", () => {
    const text = render(
      "task.search",
      {
        as_of: "1.1046.5n0w8k3q",
        scope: "all",
        parsed: 'zone OR "time zone"',
        total: 37,
        first: 16,
        rows: [
          {
            kind: "task",
            id: "t_5m2k8q0w3z7r1c9d4f6h8j0n2p",
            ref: "M-14",
            title: "Fix appointment time zones",
            lifecycle: "active",
            status: "open",
            inbox: false,
            priority: 1,
            effort: "M",
            due: "2026-11-13",
            area: "Client work",
            project: "Lumen Health",
            snippet: "…stored without zone…",
            snippet_from: "task",
            changed: true,
          },
          {
            kind: "task",
            id: "t_3a9c7e1g5j2k4m6n8p0q1r3s5t",
            ref: "M-3",
            title: "Fix DST bug in reports",
            lifecycle: "completed",
            status: "review",
            inbox: false,
            priority: 4,
            completed: "2026-04-03",
            snippet: "Always store UTC",
            snippet_from: "learning",
            ending: "Reports convert at render time.",
          },
          {
            kind: "task",
            id: "t_4c8e2g6j0m3p7r1t5v9x3z7b1d",
            ref: "M-4",
            title: "Retry the export",
            lifecycle: "archived",
            status: "open",
            inbox: false,
            priority: 4,
            ending: "Not needed after all.",
          },
          {
            kind: "task",
            id: "t_9b1d3f5h7k0m2p4r6t8v0x2z4b",
            ref: "M-15",
            title: "Call the clinic",
            lifecycle: "active",
            status: "open",
            inbox: false,
            priority: 4,
            due: { at: "2026-11-13T09:30:00.000Z", tz: "Europe/Lisbon" },
            snippet: "Call the clinic",
          },
          { kind: "deleted", id: "t_7d3n9p1q5s0v2w4x6y8z0a2b4c", ref: "M-22" },
          { kind: "redacted", id: "t_2h6k0m4p8r1t5v9x3z7b1d5f9g", ref: "M-9" },
        ],
        cursor: "c_7m2k9q4w1z8r3c6d",
      },
      "Mira",
    );
    expect(text.split("\n")).toEqual([
      '16–21 of 37 · scope all · parsed: zone OR "time zone"',
      "M-14 · open · P1 · M · due 2026-11-13 · Lumen Health · Fix appointment time zones — …stored without zone… *",
      "M-3 · completed 2026-04-03 · Fix DST bug in reports — learning: Always store UTC",
      "M-4 · dropped · Retry the export — Not needed after all.",
      "M-15 · open · due 2026-11-13T09:30:00.000Z (Europe/Lisbon) · Call the clinic",
      "M-22 · deleted since this search",
      "M-9 · redacted since this search",
      "More: ttasks find --cursor c_7m2k9q4w1z8r3c6d",
      "",
    ]);
    const learnings = render(
      "task.search",
      {
        as_of: "1.1046.5n0w8k3q",
        scope: "learnings",
        parsed: "",
        total: 0,
        first: 0,
        rows: [],
      },
      "Mira",
    );
    expect(learnings).toBe("0 of 0 · scope learnings\n");
  });
});

describe("[A3.3.4.organize.list] [A3.3.4.prefs.tool] ttasks area and ttasks prefs print for a person", () => {
  test("areas with their projects and counts, and keys with their values or shapes", () => {
    const groups = render(
      "group.manage",
      {
        action: "list",
        as_of: "1.1046.5n0w8k3q",
        areas: [
          {
            name: "Client work",
            active: 7,
            projects: [
              { name: "Lumen Health", active: 4, folder: "~/work/lumen", repo: "lumen-web" },
            ],
          },
          { name: "Learning", active: 1, archived: true, projects: [] },
        ],
        projects: [
          { name: "Loose", active: 0, archived: true, ref: "p_6j0n4r8v2z6c0f4j8n2r6v0z4c" },
        ],
        cursor:
          "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f.a1.p_4g8k2m6q0s4w8y2b6d0f4h8k2m",
      },
      "Mira",
    );
    expect(groups).toBe(
      [
        "Client work (7)",
        "  Lumen Health [lumen-web] (4)  ~/work/lumen",
        "Learning (1, archived)",
        "No area",
        "  Loose (0, archived, id p_6j0n4r8v2z6c0f4j8n2r6v0z4c)",
        "More: the same command with --cursor sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f.a1.p_4g8k2m6q0s4w8y2b6d0f4h8k2m",
        "",
      ].join("\n"),
    );
    // A write says what it did first.
    const created = render(
      "group.manage",
      {
        action: "create",
        as_of: "1.1047.5n0w8k3q",
        areas: [{ name: "Client work", active: 0, projects: [{ name: "Northwind", active: 0 }] }],
        projects: [],
        result: "created",
        group: { kind: "project", id: "p_9m3q7w1y5c9g3k7p1t5x9b3f7k", name: "Northwind" },
        cursor:
          "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f.a1.p_4g8k2m6q0s4w8y2b6d0f4h8k2m",
      },
      "Mira",
    );
    expect(created.split("\n")[0]).toBe("Created project Northwind");
    // A write takes no cursor: the rest is read with list, in the space and with the archived
    // groups the write asked for.
    expect(created).toContain(
      `More: ${CLI_NAME} area list --cursor sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f.a1.p_4g8k2m6q0s4w8y2b6d0f4h8k2m\n`,
    );
    const elsewhere = (platform: NodeJS.Platform) =>
      render(
        "group.manage",
        {
          action: "archive",
          as_of: "1.1047.5n0w8k3q",
          areas: [],
          projects: [],
          result: "archived",
          group: { kind: "area", id: "a_8n2r6v0z4c8f2j6n0r4v8z2c6f", name: "Home" },
          cursor: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f",
        },
        "Side work",
        { space: "Side work", archived: true, platform },
      );
    expect(elsewhere("linux")).toContain(
      `More: ${CLI_NAME} area list --space 'Side work' --archived --cursor sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f\n`,
    );
    expect(elsewhere("win32")).toContain(
      `More: ${CLI_NAME} area list --space 'Side work' --archived --cursor sp_7c0hq2m4w9d8k1r6t3v5x0b2nf.a0.a_8n2r6v0z4c8f2j6n0r4v8z2c6f\n`,
    );
    const same = render(
      "group.manage",
      {
        action: "create",
        as_of: "1.1047.5n0w8k3q",
        areas: [],
        projects: [],
        result: "no_change",
        group: { kind: "area", id: "a_8n2r6v0z4c8f2j6n0r4v8z2c6f", name: "Home" },
      },
      "Mira",
    );
    expect(same).toBe("No change to area Home\n");
    // A moved folder names what moved along with it, and what stayed and why.
    const write = (extra: Record<string, unknown>) =>
      render(
        "group.manage",
        {
          action: "set_folder",
          as_of: "1.1048.5n0w8k3q",
          areas: [],
          projects: [],
          result: "folder_set",
          group: { kind: "project", id: "p_9m3q7w1y5c9g3k7p1t5x9b3f7k", name: "Portal" },
          ...extra,
        },
        "Mira",
      )
        .split("\n")
        .slice(1, -1);
    expect(
      write({
        moved: 2,
        followed: [
          { kind: "task", ref: "M-14", folder: "~/code/portal/web" },
          { kind: "project", name: "Portal api", folder: "~/code/portal/api" },
        ],
        stayed: 30,
        stayed_because: "not_in_new_folder",
        kept: [{ kind: "task", ref: "M-17", folder: "~/work/portal/old" }],
      }),
    ).toEqual([
      "The old folder was moved: 2 folders inside it moved along.",
      "  M-14  ~/code/portal/web",
      "  project Portal api  ~/code/portal/api",
      "30 folders inside the old one stay where they are: they are not in the new folder.",
      "  M-17  ~/work/portal/old",
      "  and 29 more",
    ]);
    const kept = [{ kind: "task", ref: "M-15", folder: "~/work/portal/docs" }];
    const why = (because: string) =>
      write({ stayed: 1, stayed_because: because, kept }).filter((line) => !line.startsWith(" "));
    expect(why("old_folder_there")).toEqual([
      "1 folder inside the old one stays where it is: the old folder is still there.",
    ]);
    expect(why("old_folder_unseen")).toEqual([
      "1 folder inside the old one stays where it is: the old folder cannot be seen and nothing shows that the new one is it.",
    ]);
    expect(why("unchecked")).toEqual([
      "1 folder inside the old one stays where it is: a folder could not be checked.",
    ]);
    expect(why("not_in_new_folder")).toEqual([
      "1 folder inside the old one stays where it is: it is not in the new folder.",
    ]);
    const got = render(
      "prefs.manage",
      {
        action: "get",
        as_of: "1.1046.5n0w8k3q",
        prefs: [
          { key: "autonomy.level", value: "review", is_default: true, policy: true },
          { key: "tasks.statuses", value: ["open", "parked"] },
        ],
      },
      "Mira",
    );
    expect(got).toBe(
      'autonomy.level: "review" (default) · policy\ntasks.statuses: ["open","parked"]\n',
    );
    const described = render(
      "prefs.manage",
      {
        action: "describe",
        as_of: "1.1046.5n0w8k3q",
        prefs: [
          { key: "tasks.statuses", summary: "The statuses", shape: "a list of 1 to 12 keys" },
        ],
      },
      "Mira",
    );
    expect(described.split("\n")[0]).toBe("tasks.statuses: The statuses (a list of 1 to 12 keys)");
  });

  test("a command it tells the person to run next names the space this one was run for", () => {
    const asked = { space: "Second space", person: true, platform: "linux" as const };
    // Without the space, the pasted command would act on the default space's task of that reference.
    const removed = render(
      "note.remove",
      { result: "removed", note: "n1", task: "M-13" },
      "Second space",
      asked,
    );
    expect(removed).toContain("ttasks note M-13 --put-back 1 --space 'Second space'");
    const shown = render(
      "task.get",
      {
        task: {
          ref: "M-13",
          title: "Fixture",
          deleted: { at: "2026-11-20T10:00:00Z", by: "user" },
        },
        removed_notes: [
          { ref: "n1", text: "Fixture note", removed: { at: "2026-11-20", by: "user" } },
        ],
      },
      "Second space",
      asked,
    );
    expect(shown).toContain("Restore it with ttasks restore M-13 --space 'Second space'");
    expect(shown).toContain("ttasks note M-13 --space 'Second space' --put-back <number>");
    // In the default space nothing is added.
    expect(
      render("note.remove", { result: "removed", note: "n1", task: "M-13" }, "Mira", {
        platform: "linux",
      }),
    ).toContain("put it back with ttasks note M-13 --put-back 1" + String.fromCharCode(10));
  });

  test("[A3.3.4.prefs.set] a set says what changed from and to, or that nothing did", () => {
    const row = { key: "tasks.effort_scale", value: ["XS", "S", "M", "L", "XL"], default: [] };
    const set = (changed: unknown[]) =>
      render(
        "prefs.manage",
        { action: "set", as_of: "1.1046.5n0w8k3q", prefs: [row], result: "updated", changed },
        "Mira",
      );
    expect(
      set([{ key: "tasks.effort_scale", from: ["S", "M", "L"], to: ["XS", "S", "M", "L", "XL"] }]),
    ).toBe('tasks.effort_scale: ["S","M","L"] → ["XS","S","M","L","XL"]\n');
    expect(set([])).toBe(
      'Nothing changed: the value was so already.\ntasks.effort_scale: ["XS","S","M","L","XL"]\n',
    );
  });
});

describe("[A3.3.5.error-text] a message and its hint, each said once", () => {
  test("a full stop between them, Run: before a bare command, a hint the message says left out", () => {
    expect(
      messageWithHint("A field changed after the base: read again", "Read it.", "ttasks"),
    ).toBe("A field changed after the base: read again. Read it.");
    expect(messageWithHint("The service is not running.", "ttasks service start", "ttasks")).toBe(
      "The service is not running. Run: ttasks service start",
    );
    expect(
      messageWithHint(
        "The service is not running. Start it with: ttasks service start",
        "ttasks service start",
        "ttasks",
      ),
    ).toBe("The service is not running. Start it with: ttasks service start.");
    expect(messageWithHint("Something went wrong!", undefined, "ttasks")).toBe(
      "Something went wrong!",
    );
    expect(messageWithHint("Gone", "  ", "ttasks")).toBe("Gone.");
    // A message that ends with a colon is finished by its hint, else by a full stop.
    expect(messageWithHint("Could not start:", "ttasks doctor", "ttasks")).toBe(
      "Could not start: ttasks doctor",
    );
    expect(messageWithHint("Could not start:", undefined, "ttasks")).toBe("Could not start.");
    // An empty message is its hint alone, with no space before it.
    expect(messageWithHint("", "ttasks doctor", "ttasks")).toBe("Run: ttasks doctor");
    expect(messageWithHint(" ", "Read it again.", "ttasks")).toBe("Read it again.");
    // Only a message that ends with the hint says it already: one that names the command for
    // another reason keeps the hint.
    expect(messageWithHint("ttasks doctor failed", "ttasks doctor", "ttasks")).toBe(
      "ttasks doctor failed. Run: ttasks doctor",
    );
    expect(messageWithHint("Run: xttasks doctor", "ttasks doctor", "ttasks")).toBe(
      "Run: xttasks doctor. Run: ttasks doctor",
    );
    expect(messageWithHint("Read it again. Then wait", "Read it again.", "ttasks")).toBe(
      "Read it again. Then wait. Read it again.",
    );
  });

  test("every printed error joins its message and hint by that rule", () => {
    const io = recorder();
    printError(io, false, {
      code: "conflict",
      message: "A field changed after the base: read again",
      hint: "Read the task again, then send the change with a new request ID.",
    });
    expect(io.err).toBe(
      "error conflict: A field changed after the base: read again. Read the task again, then send the change with a new request ID.\n",
    );
  });
});

describe("[A3.answers.absent] a write's answer prints without any field it may leave out", () => {
  /**
   * `value` without every field its JSON schema does not require, at every depth, but a draft's
   * reference: only a proposal's draft has none, and it is not added.
   */
  function bare(schema: Record<string, unknown>, value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => bare((schema["items"] ?? {}) as Record<string, unknown>, v));
    }
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    if (typeof value !== "object" || value === null || properties === undefined) return value;
    const required = new Set([...((schema["required"] ?? []) as string[]), "ref"]);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => required.has(key))
        .map(([key, v]) => [key, bare(properties[key] ?? {}, v)]),
    );
  }

  test("every write's example answer, with every field it may leave out left out, prints", () => {
    for (const entry of registry.filter((e) => e.kind === "write" && e.faces.cli !== undefined)) {
      entry.examples.forEach((ex, i) => {
        const key = `${entry.name} ${String(i)}`;
        const answer = bare(outputJsonSchema(entry), ex.output) as Record<string, unknown>;
        expect(entry.output.safeParse(answer).success, key).toBe(true);
        expect(render(entry.name, answer, "Mira"), key).not.toContain("undefined");
      });
    }
  });

  test("a request ID with no receipt may be sent again, and one another version applied may not", () => {
    expect(render("receipt.get", { found: false }, "Mira")).toBe(
      "No receipt for that request ID in this writer scope: nothing was written under it, and the request can be sent again.\n",
    );
    const io = recorder();
    const code = printError(io, false, {
      code: "applied_earlier",
      message: `Another version of ${PRODUCT_NAME} applied this request before (M-14): nothing was written now.`,
      hint: "Do not send it again under a new request ID. Read the task for how it is now.",
      data: { request: "fixture-request-000001", receipt: { found: true, results: [] } },
    });
    expect(io.err).toBe(
      `error applied_earlier: Another version of ${PRODUCT_NAME} applied this request before (M-14): nothing was written now. Do not send it again under a new request ID. Read the task for how it is now.\n`,
    );
    expect(code).toBe(EXIT_CODES.conflict);
  });
});
