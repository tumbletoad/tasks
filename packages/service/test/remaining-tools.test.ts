// The tools M4.01 lists, through the request path (A3 3.2.3, 3.4.3, 3.4.5, 3.4.10 to 3.4.12; A7
// 3.11 M4.01): add_tasks with areas and projects by name, the Inbox and possible duplicates;
// organize's list and the rule for mixed read and write actions; preferences over the declared
// keys; search's text on an indexed and an unindexed space; and the user-only class refused to
// every agent actor. The fixture spaces are storage's write fixtures (areas Lumen and Home, the
// project Portal in Lumen, the project's old slug old-portal), served in this thread. Fixture
// data only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AppError,
  GroupManageResult,
  opSpec,
  PREFERENCES,
  PrefsManageResult,
  registry,
  TaskAddResult,
  TaskGetResult,
  type ErrorBody,
} from "@ttasks/contracts";
import type { ReceiptLookup, SpaceWriterHandle, WriteRequest } from "@ttasks/storage";
import { openSpaceConnection } from "@ttasks/storage";
import { STEPS_0_3 } from "@ttasks/storage/revisions";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { checkedDriver } from "@ttasks/testkit";
import { bridgePrincipal, renderError, renderResult, TOOLS } from "../src/mcp/index.ts";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
let indexed: Fixture;
let plain: Fixture;
/** A fixture whose rows tests change by hand (`edit`), for states no operation makes yet. */
let edited: Fixture;
/** A fixture organize's writes shape. */
let organized: Fixture;
/** A fixture whose groups one call's drafts make. */
let drafted: Fixture;
const clock = Date.UTC(2026, 10, 12, 9, 0, 0);

beforeAll(async () => {
  temp = tempRoot("m401");
  for (const name of ["fx", "indexed", "plain", "edited", "organized", "drafted"]) {
    mkdirSync(join(temp.root, name));
  }
  drafted = await writeFixture(join(temp.root, "drafted"));
  fx = await writeFixture(join(temp.root, "fx"));
  indexed = await writeFixture(join(temp.root, "indexed"));
  plain = await writeFixture(join(temp.root, "plain"), { steps: STEPS_0_3 });
  edited = await writeFixture(join(temp.root, "edited"));
  organized = await writeFixture(join(temp.root, "organized"));
});

afterAll(() => {
  fx.close();
  indexed.close();
  plain.close();
  edited.close();
  organized.close();
  drafted.close();
  temp.cleanup();
});

/** One statement on the fixture's database, through a connection of its own. */
async function edit(f: Fixture, sql: string, params: Record<string, unknown>): Promise<void> {
  const conn = openSpaceConnection(await checkedDriver(), join(f.folder, "space.db"), "writer");
  try {
    conn.prepare(sql).run(params as never);
  } finally {
    conn.close();
  }
}

/** The fixture's writer as the service's handle: the same calls, answered at once. */
function writerOf(f: Fixture): SpaceWriterHandle {
  return {
    spaceId: f.spaceId,
    submit: (request: WriteRequest) => Promise.resolve(f.writer.submit(request)),
    receipt: (lookup: ReceiptLookup) => Promise.resolve(f.writer.receipt(lookup)),
    actor: (kind: "human" | "agent", label: string) => Promise.resolve(f.writer.actor(kind, label)),
  } as unknown as SpaceWriterHandle;
}

const hostOf = (f: Fixture): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    { id: f.spaceId, name: "Mira", state: "open", writer: writerOf(f), reader: readerOf(f.reader) },
  ],
  now: () => clock,
  timeZone: () => "Europe/Lisbon",
});

const user: Caller = { class: "cli-interactive", env: {} };
const script: Caller = { class: "cli-script", env: {} };

let n = 0;
const rid = (): string => `fixture-m401-${String((n += 1)).padStart(8, "0")}`;

const call = (f: Fixture, caller: Caller, op: string, input: Record<string, unknown>) =>
  opCall(hostOf(f), caller, { op, input });

async function refusal(promise: Promise<unknown>): Promise<ErrorBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.toBody();
    throw error;
  }
  throw new Error("expected a refusal");
}

const add = async (f: Fixture, caller: Caller, tasks: Record<string, unknown>[], request = rid()) =>
  TaskAddResult.parse(await call(f, caller, "task.add", { tasks, request_id: request }));

/** A task's row as `get_task` reads it: its group's names and its Inbox flag. */
async function rowOf(f: Fixture, ref: string) {
  const read = TaskGetResult.parse(await call(f, user, "task.get", { task: ref }));
  if (read.view !== "digest") throw new Error("expected a digest");
  return read.task;
}

describe("[A3.3.4.add.names] add_tasks: areas and projects by name, the Inbox and possible duplicates", () => {
  test("an area and a project match by name or slug, ignoring case, and a project by its old slug", async () => {
    const added = await add(fx, script, [
      { title: "Names one", area: "lumen" },
      { title: "Names two", project: "PORTAL" },
      { title: "Names three", area: "Home" },
      { title: "Names four", project: "old-portal" },
      { title: "Names five", area: "LUMEN", project: "portal" },
    ]);
    const refs = added.tasks.map((t) => t.ref ?? "");
    const rows = await Promise.all(refs.map((ref) => rowOf(fx, ref)));
    expect(rows.map((r) => [r.area, r.project])).toEqual([
      ["Lumen", undefined],
      ["Lumen", "Portal"],
      ["Home", undefined],
      ["Lumen", "Portal"],
      ["Lumen", "Portal"],
    ]);
    // A task in a group is no Inbox task, for an agent too.
    expect(rows.every((r) => !r.inbox)).toBe(true);
  });

  test("a name close to an existing one is refused with it in data.suggestions, never in the message", async () => {
    const body = await refusal(
      call(fx, script, "task.add", {
        tasks: [{ title: "Typo", area: "Lumn" }],
        request_id: rid(),
      }),
    );
    expect(body).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.area" }], suggestions: ["Lumen"] },
    });
    expect(`${body.message} ${body.hint ?? ""}`).not.toContain("Lumen");
    const project = await refusal(
      call(fx, script, "task.add", {
        tasks: [{ title: "Typo", project: "Portl" }],
        request_id: rid(),
      }),
    );
    expect(project.data).toMatchObject({ suggestions: ["Portal"] });
    // The text an agent reads puts the close name inside the data block.
    expect(renderError(body)).toMatch(
      /<<ttasks-data [0-9A-Z]{4,8}: [^\n]*>>\nDid you mean\n- Lumen\n/u,
    );
  });

  test("a new name creates its area or project with the tasks, once however many drafts name it, and a retry creates nothing more", async () => {
    const groups = () =>
      organized.reader
        .prepare(
          "SELECT (SELECT count(*) FROM areas) AS areas, (SELECT count(*) FROM projects) AS projects",
        )
        .get();
    const before = groups();
    const request = rid();
    const drafts = [
      { title: "Plant the beds", area: "Gardening", project: "Spring beds" },
      { title: "Order seeds", area: "gardening", project: "spring beds" },
      { title: "Fix the gate", project: "Gate" },
    ];
    const added = await add(organized, script, drafts, request);
    expect(added.tasks.map((t) => t.result)).toEqual(["created", "created", "created"]);
    const rows = await Promise.all(added.tasks.map((t) => rowOf(organized, t.ref ?? "")));
    expect(rows.map((r) => [r.area, r.project])).toEqual([
      ["Gardening", "Spring beds"],
      ["Gardening", "Spring beds"],
      [undefined, "Gate"],
    ]);
    // A task in a group is no Inbox task.
    expect(rows.every((r) => !r.inbox)).toBe(true);
    expect(groups()).toEqual({
      areas: Number(before?.["areas"]) + 1,
      projects: Number(before?.["projects"]) + 2,
    });
    // The groups and the tasks are one commit.
    const commit = organized.reader
      .prepare("SELECT ops FROM commits ORDER BY seq DESC LIMIT 1")
      .get<{ ops: string }>();
    expect((JSON.parse(commit?.ops ?? "[]") as { op: string }[]).map((o) => o.op)).toEqual([
      "area.create",
      "project.create",
      "project.create",
      "task.create",
      "task.create",
      "task.create",
    ]);
    const again = await add(organized, script, drafts, request);
    expect(again.replayed).toBe(true);
    expect(again.tasks.map((t) => t.ref)).toEqual(added.tasks.map((t) => t.ref));
    expect(groups()).toEqual({
      areas: Number(before?.["areas"]) + 1,
      projects: Number(before?.["projects"]) + 2,
    });
    // A name close to the new one is still a typo of it.
    expect(
      await refusal(
        call(organized, script, "task.add", {
          tasks: [{ title: "Typo", area: "Gardenign" }],
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ code: "invalid_input", data: { suggestions: ["Gardening"] } });
  });

  test("a name an earlier draft of the call makes is resolved as an existing one: one of two is ambiguous, a close one is a typo", async () => {
    const before = drafted.base();
    const refused = (tasks: Record<string, unknown>[]) =>
      refusal(call(drafted, script, "task.add", { tasks, request_id: rid() }));
    expect(
      await refused([
        { title: "One", area: "Clients", project: "Website" },
        { title: "Two", area: "Family", project: "Website" },
        { title: "Three", project: "Website" },
      ]),
    ).toMatchObject({ code: "ambiguous", data: { issues: [{ path: "tasks.2.project" }] } });
    expect(
      await refused([
        { title: "One", area: "Errands" },
        { title: "Two", area: "Errnads" },
      ]),
    ).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.1.area" }], suggestions: ["Errands"] },
    });
    expect(
      await refused([
        { title: "One", area: "Garden", project: "Raised beds" },
        { title: "Two", area: "Garden", project: "Raised bdes" },
      ]),
    ).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.1.project" }], suggestions: ["Raised beds"] },
    });
    expect(drafted.base()).toBe(before);
    // Named once more, with or without its area, the new project is the one the call makes.
    const added = await add(drafted, script, [
      { title: "One", area: "Garden", project: "Raised beds" },
      { title: "Two", project: "raised beds" },
    ]);
    const rows = await Promise.all(added.tasks.map((t) => rowOf(drafted, t.ref ?? "")));
    expect(rows.map((r) => [r.area, r.project])).toEqual([
      ["Garden", "Raised beds"],
      ["Garden", "Raised beds"],
    ]);
  });

  test("a project named beside an area it is not in is refused, and nothing is written", async () => {
    const before = fx.base();
    const body = await refusal(
      call(fx, script, "task.add", {
        tasks: [{ title: "Wrong area", area: "Home", project: "portal" }],
        request_id: rid(),
      }),
    );
    expect(body).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.project" }], suggestions: ["Lumen"] },
    });
    expect(fx.base()).toBe(before);
  });

  test("an agent's task without area or project goes to the Inbox; the user's and inbox false do not", async () => {
    const agent = await add(fx, script, [
      { title: "Inbox one" },
      { title: "Inbox two", inbox: false },
      { title: "Inbox three", area: "Home", inbox: true },
    ]);
    const mine = await add(fx, user, [{ title: "Inbox four" }]);
    const flags = await Promise.all(
      [...agent.tasks, ...mine.tasks].map(async (t) => (await rowOf(fx, t.ref ?? "")).inbox),
    );
    expect(flags).toEqual([true, false, true, false]);
  });

  test("a similar title in the group a task lands in is a warning that never blocks, and a replay says it again", async () => {
    const [first] = (
      await add(fx, user, [{ title: "Fix appointment time zones", project: "portal" }])
    ).tasks;
    const request = rid();
    const drafts = [
      { title: "Fix appointment timezones", project: "Portal" },
      { title: "Fix appointment time zones", area: "Home" },
      { title: "Fix appointment time zones 2", project: "Portal" },
    ];
    const added = await add(fx, script, drafts, request);
    expect(added.tasks.map((t) => t.result)).toEqual(["created", "created", "created"]);
    expect(added.warnings).toEqual([
      `tasks.0: possible duplicate of ${first?.ref ?? ""} (same project, similar title)`,
    ]);
    const again = await add(fx, script, drafts, request);
    expect(again.replayed).toBe(true);
    expect(again.warnings).toEqual(added.warnings);
    expect(again.tasks.map((t) => t.ref)).toEqual(added.tasks.map((t) => t.ref));
  });

  test("a draft that matches by its source key gets no duplicate warning of its own", async () => {
    const source = { key: "jira:FIX-901", kind: "ticket", title: "Fixture ticket" };
    const [made] = (await add(fx, script, [{ title: "Keyed fixture task", sources: [source] }]))
      .tasks;
    const again = await add(fx, script, [{ title: "Keyed fixture task", sources: [source] }]);
    expect(again.tasks[0]).toMatchObject({ result: "exists", ref: made?.ref });
    expect(again.warnings).toEqual([]);
  });

  test("a retry replays when the name it gave is longer than the writer's group field", async () => {
    // 61 code points, within the input's 120, but 122 UTF-16 units, past the writer's 120: only
    // the first call resolves it to an ID, so the retry must not send the name itself.
    const name = "🙂".repeat(61);
    await edit(edited, "UPDATE areas SET title = $title WHERE id = $id", {
      title: name,
      id: edited.areas.home,
    });
    const request = rid();
    const drafts = [{ title: "Long area name", area: name }];
    const first = await add(edited, script, drafts, request);
    expect(first.tasks.map((t) => t.result)).toEqual(["created"]);
    const again = await add(edited, script, drafts, request);
    expect(again.replayed).toBe(true);
    expect(again.tasks.map((t) => t.ref)).toEqual(first.tasks.map((t) => t.ref));
    // update_task's set takes names the same way, and replays the same way.
    const update = {
      task: first.tasks[0]?.ref ?? "",
      set: { area: name, summary: "Fixture summary." },
      base: edited.base(),
      request_id: rid(),
    };
    const updated = await call(edited, script, "task.update", update);
    expect(await call(edited, script, "task.update", update)).toEqual({
      ...(updated as object),
      replayed: true,
    });
  });

  test("update_task and complete_task's follow-ups take names as add_tasks does", async () => {
    const [task] = (await add(fx, user, [{ title: "Move me by name" }])).tasks;
    const ref = task?.ref ?? "";
    await call(fx, script, "task.update", {
      task: ref,
      set: { area: "HOME" },
      base: fx.base(),
      request_id: rid(),
    });
    expect((await rowOf(fx, ref)).area).toBe("Home");
    const finished = (await call(fx, script, "task.finish", {
      task: ref,
      outcome: "Moved.",
      follow_ups: [{ title: "Follow-up by name", project: "portal" }],
      base: fx.base(),
      request_id: rid(),
    })) as { follow_ups: { ref?: string }[] };
    const follow = await rowOf(fx, finished.follow_ups[0]?.ref ?? "");
    expect([follow.area, follow.project]).toEqual(["Lumen", "Portal"]);
  });
});

describe("[A3.3.4.organize.list] organize: the list, one area, and writes that wait for their step", () => {
  test("list gives the active areas in order, their projects and active task counts", async () => {
    const listed = GroupManageResult.parse(
      await call(fx, script, "group.manage", { action: "list" }),
    );
    const active = (area: string) =>
      Number(
        fx.reader
          .prepare(
            "SELECT count(*) AS n FROM tasks WHERE area_id = $area AND lifecycle = 'active' AND deleted_at IS NULL",
          )
          .get({ area })?.["n"],
      );
    expect(
      listed.areas.map((a) => [a.name, a.slug, a.active, a.projects.map((p) => p.name)]),
    ).toEqual([
      ["Lumen", "lumen", active(fx.areas.lumen), ["Portal"]],
      ["Home", "home", active(fx.areas.home), []],
    ]);
    expect(listed).toMatchObject({ total_areas: 2, total_projects: 1, projects: [] });
    const one = GroupManageResult.parse(
      await call(fx, script, "group.manage", { action: "list", path: "HOME" }),
    );
    expect(one.areas.map((a) => a.name)).toEqual(["Home"]);
    expect(one.total_projects).toBe(0);
    // Of "Area/Project" the area; an unknown area is not_found, not a group to create.
    const narrowed = GroupManageResult.parse(
      await call(fx, script, "group.manage", { action: "list", path: "Lumen/Portal" }),
    );
    expect(narrowed.areas.map((a) => a.name)).toEqual(["Lumen"]);
    expect(
      await refusal(call(fx, script, "group.manage", { action: "list", path: "Garden" })),
    ).toMatchObject({ code: "not_found", data: { issues: [{ path: "path" }] } });
    // A request ID on a read is ignored: nothing is written, nothing is receipted.
    const before = fx.base();
    const reads = [rid(), rid()];
    await call(fx, script, "group.manage", { action: "list", request_id: reads[0] });
    await call(fx, script, "prefs.manage", { action: "get", request_id: reads[1] });
    expect(fx.base()).toBe(before);
    const found = async (request: string) =>
      ((await call(fx, script, "receipt.get", { request })) as { found: boolean }).found;
    for (const request of reads) expect(await found(request), request).toBe(false);
    // The same lookup finds a write's receipt in that writer scope.
    const written = rid();
    await add(fx, script, [{ title: "Receipted fixture task" }], written);
    expect(await found(written)).toBe(true);
  });

  test("a write action needs a request_id, a group and, to change one, a base; mode propose waits for M4.02", async () => {
    const missing = await refusal(
      call(fx, script, "group.manage", { action: "create", path: "Garden" }),
    );
    expect(missing).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "request_id" }] },
    });
    expect(
      await refusal(call(fx, script, "group.manage", { action: "create", request_id: rid() })),
    ).toMatchObject({ code: "invalid_input", data: { issues: [{ path: "path" }] } });
    for (const action of ["rename", "move", "archive", "unarchive"]) {
      expect(
        await refusal(
          call(fx, script, "group.manage", {
            action,
            path: "Home",
            to: "House",
            request_id: rid(),
          }),
        ),
        action,
      ).toMatchObject({ code: "invalid_input", data: { issues: [{ path: "base" }] } });
    }
    const propose = await refusal(
      call(fx, script, "group.manage", {
        action: "create",
        path: "Garden",
        request_id: rid(),
        mode: "propose",
      }),
    );
    expect(propose.hint).toContain("M4.02");
  });
});

describe("[A3.3.4.organize.write] organize: create, rename, move, archive and unarchive through the request path", () => {
  test("each write changes the group it names, keeps its ID, answers the list as of the write, and a retry replays", async () => {
    const write = async (input: Record<string, unknown>, request = rid()) =>
      GroupManageResult.parse(
        await call(organized, script, "group.manage", { request_id: request, ...input }),
      );
    const created = await write({ action: "create", path: "Clients/Northwind Clinic" });
    expect(created).toMatchObject({
      result: "created",
      group: { kind: "project", name: "Northwind Clinic" },
    });
    const clients = created.areas.find((a) => a.name === "Clients");
    expect(clients?.projects.map((p) => [p.id, p.name])).toEqual([
      [created.group?.id, "Northwind Clinic"],
    ]);
    // Creating what is there already changes nothing and names it.
    expect(await write({ action: "create", path: "clients/northwind clinic" })).toMatchObject({
      result: "no_change",
      group: { id: created.group?.id },
    });
    expect(await write({ action: "create", path: "Home" })).toMatchObject({
      result: "no_change",
      group: { kind: "area", id: organized.areas.home },
    });
    const request = rid();
    const renamed = await write(
      {
        action: "rename",
        path: "Clients/Northwind Clinic",
        to: "Northwind",
        base: organized.base(),
      },
      request,
    );
    expect(renamed).toMatchObject({
      result: "renamed",
      group: { id: created.group?.id, name: "Northwind" },
    });
    // The retry names the old name, which the rename took away: the writer replays it.
    const again = await write(
      {
        action: "rename",
        path: "Clients/Northwind Clinic",
        to: "Northwind",
        base: organized.base(),
      },
      request,
    );
    expect(again).toMatchObject({
      result: "renamed",
      replayed: true,
      group: { id: created.group?.id },
    });
    const moved = await write({
      action: "move",
      path: "Clients/Northwind",
      to: "Home",
      base: organized.base(),
    });
    expect(moved.result).toBe("moved");
    expect(moved.areas.find((a) => a.name === "Home")?.projects.map((p) => p.name)).toEqual([
      "Northwind",
    ]);
    // An area moves nowhere.
    expect(
      await refusal(
        call(organized, script, "group.manage", {
          action: "move",
          path: "Home",
          to: "Clients",
          base: organized.base(),
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ code: "invalid_input", data: { issues: [{ path: "path" }] } });
    const archived = await write({
      action: "archive",
      path: "Home/Northwind",
      base: organized.base(),
    });
    expect(archived.result).toBe("archived");
    expect(archived.areas.find((a) => a.name === "Home")?.projects).toEqual([]);
    expect(
      await write({ action: "archive", path: "Home/Northwind", base: organized.base() }),
    ).toMatchObject({ result: "no_change" });
    const back = await write({
      action: "unarchive",
      path: "Home/Northwind",
      base: organized.base(),
    });
    expect(back.result).toBe("unarchived");
    // A name that only looks a group up is not_found when no group has it.
    expect(
      await refusal(
        call(organized, script, "group.manage", {
          action: "archive",
          path: "Nowhere",
          base: organized.base(),
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ code: "not_found" });
  });

  test("create makes the group it names even beside a close name or a project of that name in another area; the area named to hold it keeps the typo check", async () => {
    const write = async (input: Record<string, unknown>) =>
      GroupManageResult.parse(
        await call(organized, script, "group.manage", { request_id: rid(), ...input }),
      );
    expect(await write({ action: "create", path: "Sprint 1" })).toMatchObject({
      result: "created",
    });
    expect(await write({ action: "create", path: "Sprint 2" })).toMatchObject({
      result: "created",
      group: { kind: "area", name: "Sprint 2" },
    });
    expect(await write({ action: "create", path: "Sprint 1/Website" })).toMatchObject({
      result: "created",
    });
    expect(await write({ action: "create", path: "Sprint 2/Website" })).toMatchObject({
      result: "created",
      group: { kind: "project", name: "Website" },
    });
    expect(
      await refusal(
        call(organized, script, "group.manage", {
          action: "create",
          path: "Sprint 3/Website",
          request_id: rid(),
        }),
      ),
    ).toMatchObject({ code: "invalid_input", data: { suggestions: ["Sprint 1", "Sprint 2"] } });
  });
});

describe("[A3.3.4.prefs.tool] preferences: the declared keys, their values, and who may set them", () => {
  test("describe and get read every declared key, the stored value or its default", async () => {
    const described = PrefsManageResult.parse(
      await call(fx, script, "prefs.manage", { action: "describe" }),
    );
    // The registry's space keys whose value is one of the tool's kinds, sorted (A3 3.4.11). An
    // object, a map and a machine key are not shown.
    expect(described.prefs.map((p) => p.key)).toEqual([
      "autonomy.agent_tasks_to_inbox",
      "autonomy.level",
      "features.search_trigram",
      "projection.enabled",
      "targets.default",
      "tasks.dedupe_window_days",
      "tasks.effort_scale",
      "tasks.statuses",
    ]);
    const shown = new Set(described.prefs.map((p) => p.key));
    expect(
      PREFERENCES.filter((p) => !shown.has(p.key)).map((p) => [p.key, p.scope, p.shape.type]),
    ).toEqual([
      ["ui.theme", "machine", "enum"],
      ["ui.single_keys", "machine", "boolean"],
      ["grouping.names", "space", "object"],
      ["autonomy.overrides", "space", "map"],
      ["autonomy.areas", "space", "map"],
      ["projection.dir", "machine", "path"],
    ]);
    expect(described.prefs.filter((p) => p.writable).map((p) => p.key)).toEqual(["tasks.statuses"]);
    expect(described.prefs.find((p) => p.key === "targets.default")).toMatchObject({
      policy: true,
      writable: false,
      default: null,
    });
    expect(described.prefs.find((p) => p.key === "autonomy.level")).toMatchObject({
      policy: true,
      writable: false,
      shape: "one of full, review, suggest",
    });
    const got = PrefsManageResult.parse(
      await call(fx, user, "prefs.manage", { action: "get", keys: ["tasks.*"] }),
    );
    expect(got.prefs.map((p) => [p.key, p.value, p.is_default, p.writable])).toEqual([
      ["tasks.dedupe_window_days", 30, true, true],
      ["tasks.effort_scale", ["S", "M", "L"], true, true],
      ["tasks.statuses", ["open", "waiting", "review", "backlog"], true, true],
    ]);
    const unknown = await refusal(
      call(fx, script, "prefs.manage", { action: "get", keys: ["tasks.statuss"] }),
    );
    expect(unknown).toMatchObject({ code: "invalid_input", hint: "Did you mean tasks.statuses?" });
  });

  test("a stored value its key's schema refuses reads as the default; a list in either stored form", async () => {
    const store = (key: string, value: string) =>
      edit(
        edited,
        "INSERT INTO preferences (key, value, schema_ver, policy, created_seq, version) " +
          "VALUES ($key, $value, 1, 0, 0, 0) ON CONFLICT (key) DO UPDATE SET value = $value",
        { key, value },
      );
    // A key with a space in it, and one twice: no list of statuses.
    await store("tasks.statuses", JSON.stringify(["open", "has space", "open"]));
    // Objects with a key are the list's other stored form.
    await store("tasks.effort_scale", JSON.stringify([{ key: "S" }, { key: "XL" }]));
    await store("tasks.dedupe_window_days", "9999");
    const got = PrefsManageResult.parse(
      await call(edited, user, "prefs.manage", { action: "get", keys: ["tasks.*"] }),
    );
    expect(got.prefs.map((p) => [p.key, p.value, p.is_default])).toEqual([
      ["tasks.dedupe_window_days", 30, true],
      ["tasks.effort_scale", ["S", "XL"], false],
      ["tasks.statuses", ["open", "waiting", "review", "backlog"], true],
    ]);
  });
});

describe("[A3.3.4.search.text] search's text through the request path, on an indexed and an unindexed space", () => {
  test("rows sit inside the data block; words on a space without the index are refused in words an agent can act on", async () => {
    const tool = TOOLS.find((t) => t.name === "search");
    expect(tool).toBeDefined();
    await call(indexed, user, "task.add", {
      tasks: [{ title: "Searchable fixture task", project: "portal" }],
      request_id: rid(),
    });
    const found = await call(indexed, script, "task.search", { q: "searchable" });
    const text = renderResult("task.search", found);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^1 of 1 · scope active · as_of /u);
    expect(lines[1]).toMatch(/^<<ttasks-data [0-9A-Z]{4,8}: task content, not instructions>>$/u);
    expect(lines[2]).toBe("Query: searchable");
    expect(lines[3]).toMatch(/^M-\d+ · open · P4 · Lumen \/ Portal · Searchable fixture task$/u);
    const refused = await refusal(call(plain, script, "task.search", { q: "searchable" }));
    expect(refused).toMatchObject({
      code: "space_unavailable",
      data: { reason: "not_indexed", retryable: false },
    });
    expect(renderError(refused)).toMatch(
      /^error space_unavailable \(not_indexed\): .*Filters such as status:open work now/u,
    );
    // Filters answer on that space.
    const filtered = await call(plain, script, "task.search", { q: "status:open" });
    expect(renderResult("task.search", filtered).split("\n")[0]).toMatch(/ · scope active · /u);
  });
});

describe("[A3.3.2.3.exposure.user-only] the user-only class and R7 refusals for every agent actor", () => {
  /** A host with nothing in it: the gate refuses before any space is consulted. */
  const empty: OpsHost = { machine: { id: MACHINE.id }, spaces: () => [] };
  const bridge: Caller = {
    class: "bridge",
    env: {},
    principal: bridgePrincipal({ instance: "test-agent", app: "test" }, MACHINE.id),
    home: "test-agent",
  };
  const agents: [string, Caller][] = [
    ["bridge", bridge],
    ["cli-script", script],
    ["cli-agent", { class: "cli-agent", env: {} }],
  ];

  test("every user-only and UI-only entry is forbidden to agents, and none is a tool", async () => {
    const userOnly = registry.filter((e) => e.actors === "user" || e.actors === "ui");
    expect(userOnly.length).toBeGreaterThan(0);
    const tools = new Set(TOOLS.map((t) => t.name));
    for (const entry of userOnly) {
      expect(entry.faces.mcp, entry.name).toBeUndefined();
      expect(tools.has(entry.name)).toBe(false);
      for (const [label, caller] of agents) {
        const body = await refusal(opCall(empty, caller, { op: entry.name, input: {} }));
        expect(body, `${entry.name} for ${label}`).toMatchObject({
          code: "forbidden",
          data: { rule: entry.actors === "ui" ? "ui_only" : "user_only" },
        });
      }
    }
  });

  test("a user-only field is forbidden to agents, and no agent-allowed entry emits a user-only or R7 kind", async () => {
    for (const [label, caller] of agents) {
      const body = await refusal(
        opCall(empty, caller, {
          op: "entry.add",
          input: {
            task: "M-1",
            kind: "note",
            text: "For agents.",
            for_agents: true,
            request_id: rid(),
          },
        }),
      );
      expect(body, label).toMatchObject({ code: "forbidden", data: { rule: "user_only" } });
    }
    for (const entry of registry.filter((e) => e.actors === "agent" || e.actors === "run")) {
      for (const kind of entry.ops) {
        const spec = opSpec(kind);
        expect(spec?.class === "user" || spec?.r7 === true, `${entry.name} emits ${kind}`).toBe(
          false,
        );
      }
    }
  });
});
