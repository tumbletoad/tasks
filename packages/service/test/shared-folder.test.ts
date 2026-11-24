// Any number of projects on one folder, through the real service in this process: projects made
// for one repository from the page's and the command line's writes, each answer naming the others;
// the folder's marker naming every project and a marker of an earlier build kept; an agent's
// status in the folder; a new task from the folder, from an agent that is not bound and from a
// session bound to one of the projects' tasks; one project leaving the folder; and the folder
// renamed on disk, followed for all of them. Fixture text and temporary folders only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FOLDER_MARKER } from "@ttasks/brand";
import { toolCaller } from "../src/mcp/index.ts";
import { opCall, type Binding, type Caller } from "../src/ops/index.ts";
import { readFolders } from "../src/ops/read.ts";
import { launchContext } from "./agents.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { openMcp, RawMcp, textOf } from "./mcp-helpers.ts";

type Json = Record<string, unknown>;
const LONG = 180_000;

let w: ContractWorld & { root: string };
beforeAll(async () => {
  w = await contractWorld("shared-folder");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const USER: Caller = { class: "cli-interactive", env: {} };
/** An agent's bridge in the world's space, bound to no task. */
const inSpace = (): Binding => ({ kind: "none", space: w.space, named: false });
/** A script on this machine, as an agent's shell calls. */
const agent = (): Caller => ({ class: "cli-script", env: {} });

async function call(op: string, input: Json, caller: Caller = USER): Promise<Json> {
  return (await opCall(w.service.ops, caller, { op, input })) as Json;
}

let n = 0;
const rid = () => `fixture-shared-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

function folder(...parts: string[]): string {
  const path = join(w.root, ...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

const addProject = (project: string, area: string, path: string) =>
  call("folder.manage", { action: "add_project", project, area, folder: path, request_id: rid() });

const names = (answer: Json): string[] =>
  ((answer["also"] as Json[] | undefined) ?? []).map((p) => String(p["name"])).sort();

/** The project IDs the folder's marker names. */
const marked = (path: string): string[] =>
  (
    JSON.parse(readFileSync(join(path, FOLDER_MARKER, "owners.json"), "utf8")) as {
      owners: { project?: string }[];
    }
  ).owners.flatMap((o) => (o.project === undefined ? [] : [o.project]));

const reader = () => {
  const served = w.service.ops.spaces().find((s) => s.id === w.space);
  if (served?.reader === undefined) throw new Error("the space is not served");
  return served.reader;
};
const folderOf = async (project: string) =>
  (await readFolders(reader(), "project", project)).map((f) => f.path);

const idOf = (answer: Json, at: "owner" | "group"): string => String((answer[at] as Json)["id"]);

describe("[A1.3.15.folders.shared] any number of projects on one folder", () => {
  test(
    "projects share a repository from the page and the command line; status, new tasks, a project leaving and a rename serve them all",
    { timeout: LONG },
    async () => {
      const repo = folder("work", "repo");
      // An earlier build's marker for a project of its own: kept, and the others join it.
      const legacy = await addProject("Feature", "Client work", repo);
      expect(legacy).toMatchObject({ result: "created" });
      expect(legacy["also"]).toBeUndefined();
      const feature = idOf(legacy, "owner");
      writeFileSync(
        join(repo, FOLDER_MARKER, "owners.json"),
        `${JSON.stringify({ owners: [{ space: w.space, project: feature }] })}\n`,
      );

      // The page's add_project: a second and a third project, the third of a name another area
      // has; each answer names the others with this folder.
      const bugs = await addProject("Bugs", "Client work", repo);
      expect(bugs).toMatchObject({ result: "created", owner: { name: "Bugs" } });
      expect(names(bugs)).toEqual(["Feature"]);
      const personal = await addProject("Bugs", "Personal", repo);
      expect(personal).toMatchObject({ result: "created" });
      expect(names(personal)).toEqual(["Bugs", "Feature"]);
      // The same name in the same area is the project asked for: nothing is made.
      const again = await addProject("bugs", "Client work", repo);
      expect(again).toMatchObject({ result: "exists", owner: { id: idOf(bugs, "owner") } });

      // The command line's `area create` with the folder: a fourth.
      const release = await call(
        "group.manage",
        { action: "create", path: "Client work/Release", folder: repo, request_id: rid() },
        USER,
      );
      expect(release).toMatchObject({ result: "created", group: { name: "Release" } });
      expect(names(release)).toEqual(["Bugs", "Bugs", "Feature"]);
      const all = [feature, idOf(bugs, "owner"), idOf(personal, "owner"), idOf(release, "group")];
      expect(marked(repo).sort()).toEqual([...all].sort());
      expect(marked(repo)[0]).toBe(feature);

      // An agent's status in the folder lists the tasks of every project, each with its project.
      await call(
        "task.add",
        {
          tasks: [
            { title: "Fixture feature task", area: "Client work", project: "Feature" },
            { title: "Fixture bug task", area: "Client work", project: "Bugs" },
          ],
          request_id: rid(),
        },
        USER,
      );
      const status = await call("space.status", { cwd: repo }, agent());
      const here = (status["here"] as Json[]).map((t) => [t["title"], t["project"]]);
      expect(here).toEqual(
        expect.arrayContaining([
          ["Fixture feature task", "Feature"],
          ["Fixture bug task", "Bugs"],
        ]),
      );
      const tool = toolCaller({
        ops: w.service.ops,
        context: { space: null, instance: null, app: null, env: {} },
        conn: 1,
        binding: inSpace(),
      });
      const text = textOf(await tool("status", { cwd: repo }));
      expect(text).toMatch(/Fixture feature task · Client work \/ Feature · exact/u);
      expect(text).toMatch(/Fixture bug task · Client work \/ Bugs · exact/u);

      // A new task from the folder by an agent bound to no task: the Inbox, and it is told why.
      const loose = textOf(
        await tool("add_tasks", {
          tasks: [{ title: "Fixture loose task", folder: "cwd" }],
          cwd: repo,
          request_id: rid(),
        }),
      );
      const looseRef = /tasks\.0: created (M-\d+)/u.exec(loose)?.[1] ?? "";
      expect(await call("task.get", { task: looseRef })).toMatchObject({ task: { inbox: true } });
      expect(loose).not.toContain("tasks.0: in ");
      expect(loose).toMatch(
        /warning: tasks\.0\.folder: the folder is the folder of .+, so the task is in the Inbox\. Name its project to file it there\./u,
      );

      // From a session bound to the Bugs task: into Bugs, and the answer says so.
      const bugRef = (status["here"] as Json[]).find((t) => t["title"] === "Fixture bug task")?.[
        "ref"
      ];
      const launch = await w.launch(String(bugRef));
      const bound = new RawMcp(await openMcp(w.home, w.path, launchContext(w.space, launch)));
      try {
        await bound.initialize();
        const added = textOf(
          (
            await bound.request("tools/call", {
              name: "add_tasks",
              arguments: {
                tasks: [{ title: "Fixture follow-on bug", folder: "cwd" }],
                cwd: repo,
                request_id: rid(),
              },
            })
          ).message["result"],
        );
        expect(added).toContain("tasks.0: in Bugs");
        expect(added).not.toContain("Inbox");
      } finally {
        bound.close();
      }

      // One project leaves the folder: the others keep it, and the marker names them still.
      const left = await call(
        "folder.manage",
        { action: "clear", project: idOf(release, "group"), base: await asOf(), request_id: rid() },
        USER,
      );
      expect(left).toMatchObject({ result: "cleared" });
      expect(await folderOf(idOf(release, "group"))).toEqual([]);
      expect(marked(repo).sort()).toEqual(all.slice(0, 3).sort());

      // The folder renamed on disk and given to one project: every project on it follows.
      const renamed = join(w.root, "work", "repo-renamed");
      renameSync(repo, renamed);
      const moved = await call(
        "folder.manage",
        { action: "set", project: feature, folder: renamed, base: await asOf(), request_id: rid() },
        USER,
      );
      // The two other projects, and the Inbox task that keeps the folder as its own.
      expect(moved).toMatchObject({ result: "set", moved: 3 });
      expect(names(moved)).toEqual(["Bugs", "Bugs"]);
      for (const project of all.slice(0, 3)) {
        expect(await folderOf(project)).toEqual([moved["folder"]]);
      }
      expect(marked(renamed).sort()).toEqual(all.slice(0, 3).sort());
    },
  );
});
