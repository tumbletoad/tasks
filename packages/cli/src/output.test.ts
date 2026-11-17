// Exit codes and output (A2 3.10.2, 3.10.3; A3 3.5): every error code exits with its class's code,
// --json prints exactly one document, people's text names the space of every write, diagnostics
// go to stderr. Fixture text only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ERROR_CODES, EXIT_CODES, messageWithHint, type ErrorCode } from "@tasks/contracts";
import { RpcError, LocalError } from "@tasks/bridge/protocol";
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
      already_bound: 4,
      launch_unknown: 3,
      launch_expired: 3,
      launch_used: 3,
      conflict: 4,
      wrong_tool: 2,
      forbidden: 5,
      not_permitted: 5,
      request_id_conflict: 4,
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
      hint: "Run: tasks doctor",
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

  test("tasks brief prints the pointer brief, ready to paste, or how its launch stands", () => {
    const launch = { reference: "L7KQ21", state: "dispatched" };
    expect(render("launch.open", { launch, copy: "TT Tasks task M-14\nFolder: x" }, "Mira")).toBe(
      "TT Tasks task M-14\nFolder: x\n",
    );
    expect(render("launch.open", { launch: { ...launch, state: "prepared" } }, "Mira")).toBe(
      "Launch L7KQ21: prepared\n",
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
            { ...found, lifecycle: "completed", log_added: false },
            { result: "exists", ambiguous: ["M-14", "M-15"], log_added: false },
          ],
        },
        "Mira",
      ),
    ).toBe(
      "Found M-14 in Mira by its source key, log entry added\n" +
        "Found M-14 (completed) in Mira by its source key\n" +
        "Several tasks in Mira have its source key: M-14, M-15\n",
    );
    expect(
      render("task.update", { result: "updated", task: "M-14", fields: ["summary"] }, "Mira"),
    ).toBe("Updated M-14 in Mira: summary\n");
    expect(
      render("entry.add", { kind: "evidence", entry: "l3", task: "M-14", replayed: true }, "Mira"),
    ).toBe("Logged l3 on M-14 in Mira (replayed)\n");
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

  test("no service: exit 6 with A2 3.3.6's message, and tasks alone still answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "kc-"));
    try {
      const json = recorder(["status", "--json"], { TASKS_HOME: home });
      expect(await main(json)).toBe(6);
      expect(JSON.parse(json.out)).toMatchObject({
        error: {
          code: "service_unavailable",
          class: "service",
          hint: "tasks service start",
          data: { reason: "not_running" },
        },
      });
      const text = recorder(["status"], { TASKS_HOME: home });
      expect(await main(text)).toBe(6);
      // The message and its hint, each said once (A3 3.5).
      expect(text.err).toBe(
        "error service_unavailable: TT Tasks's service is not running. Run: tasks service start\n",
      );
      const bare = recorder([], { TASKS_HOME: home });
      expect(await main(bare)).toBe(0);
      expect(bare.out).toContain("not running");
      const unknown = recorder(["frobnicate"], { TASKS_HOME: home });
      expect(await main(unknown)).toBe(2);
      // A slot no step has filled yet is a usage error. `mcp` is filled (the bridge, mcp.test.ts).
      for (const [name, command] of Object.entries(SLOTS)) {
        if (command !== undefined) continue;
        const slot = recorder([name], { TASKS_HOME: home });
        expect(await main(slot), name).toBe(2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("usage errors stay usage errors, as one JSON document, whatever --input holds", async () => {
    const home = mkdtempSync(join(tmpdir(), "kc-"));
    const run = async (argv: string[], stdin = "") => {
      const io = recorder(argv, { TASKS_HOME: home }, stdin);
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

describe("[A3.5.search.find] tasks find prints a search page", () => {
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
      "More: tasks find --cursor c_7m2k9q4w1z8r3c6d",
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

describe("[A3.3.4.organize.list] [A3.3.4.prefs.tool] tasks area and tasks prefs print for a person", () => {
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
            projects: [{ name: "Lumen Health", active: 4, folder: "~/work/lumen" }],
            more_projects: 2,
          },
          { name: "Learning", active: 1, projects: [] },
        ],
        projects: [{ name: "Loose", active: 0 }],
      },
      "Mira",
    );
    expect(groups).toBe(
      [
        "Client work (7)",
        "  Lumen Health (4)  ~/work/lumen",
        "  and 2 more projects",
        "Learning (1)",
        "No area",
        "  Loose (0)",
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
      },
      "Mira",
    );
    expect(created.split("\n")[0]).toBe("Created project Northwind");
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
});

describe("[A3.3.5.error-text] a message and its hint, each said once", () => {
  test("a full stop between them, Run: before a bare command, a hint the message says left out", () => {
    expect(messageWithHint("A field changed after the base: read again", "Read it.", "tasks")).toBe(
      "A field changed after the base: read again. Read it.",
    );
    expect(messageWithHint("The service is not running.", "tasks service start", "tasks")).toBe(
      "The service is not running. Run: tasks service start",
    );
    expect(
      messageWithHint(
        "The service is not running. Start it with: tasks service start",
        "tasks service start",
        "tasks",
      ),
    ).toBe("The service is not running. Start it with: tasks service start.");
    expect(messageWithHint("Something went wrong!", undefined, "tasks")).toBe(
      "Something went wrong!",
    );
    expect(messageWithHint("Gone", "  ", "tasks")).toBe("Gone.");
    // A message that ends with a colon is finished by its hint, else by a full stop.
    expect(messageWithHint("Could not start:", "tasks doctor", "tasks")).toBe(
      "Could not start: tasks doctor",
    );
    expect(messageWithHint("Could not start:", undefined, "tasks")).toBe("Could not start.");
    // An empty message is its hint alone, with no space before it.
    expect(messageWithHint("", "tasks doctor", "tasks")).toBe("Run: tasks doctor");
    expect(messageWithHint(" ", "Read it again.", "tasks")).toBe("Read it again.");
    // Only a message that ends with the hint says it already: one that names the command for
    // another reason keeps the hint.
    expect(messageWithHint("tasks doctor failed", "tasks doctor", "tasks")).toBe(
      "tasks doctor failed. Run: tasks doctor",
    );
    expect(messageWithHint("Run: xtasks doctor", "tasks doctor", "tasks")).toBe(
      "Run: xtasks doctor. Run: tasks doctor",
    );
    expect(messageWithHint("Read it again. Then wait", "Read it again.", "tasks")).toBe(
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
