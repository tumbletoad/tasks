// What a Library and a task's card list of the library, and the pages Today's Changes names, from
// the live store's pages. Rows from the contract's examples.
import { PAGE_FEED_EXAMPLES } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import type { PageRow } from "@ttasks/client/store";
import { areaNode, nodesOf, projectNode } from "@ttasks/client/test/nodes";
import { agentPages } from "@ttasks/client/today";
import { taskLists } from "./lists.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const [onProject, onTask] = PAGE_FEED_EXAMPLES.snapshotPages as unknown as [PageRow, PageRow];
const glossary: PageRow = {
  ...onProject,
  id: "pg_9z3d7h1m5r9w3b7f1k5p9t3x7c",
  ref: "M-103",
  title: "Glossary",
  owner_id: SPACE,
  under: SPACE,
  by: "user",
};
const NODES = new Map(
  nodesOf(
    SPACE,
    areaNode({ id: "a_lumen", title: "Client work", position: "a" }, SPACE),
    projectNode("a_lumen", { id: onProject.under, title: "Lumen Health", position: "a" }),
  ).map((node) => [node.id, node]),
);
const pages = [onProject, onTask, glossary];

describe("[A5.pages.web.card] a task's card lists its pages and what is known above it", () => {
  test("the task's own pages, then its project's, its area's and the space's, nearest first", () => {
    const task = { id: onTask.owner_id, parent: onTask.under };
    const { own, above } = taskLists(task, pages, "Mira", NODES);
    expect(own.map((page) => page.ref)).toEqual(["M-221"]);
    expect(above.map((level) => [level.node.kind, level.pages.map((page) => page.ref)])).toEqual([
      ["project", ["M-180"]],
      ["project", []],
      ["space", ["M-103"]],
    ]);
  });
});

describe("[A5.pages.web.today] Today's Changes names the pages agents changed", () => {
  test("pages an agent changed last in the past seven days, newest first; the person's own are not", () => {
    const now = Math.max(onProject.at, onTask.at) + 3_600_000;
    expect(agentPages(pages, now, 7, 5).map((page) => page.ref)).toEqual(["M-221", "M-180"]);
    expect(agentPages(pages, onProject.at + 8 * 86_400_000, 7, 5)).toEqual([]);
  });
});
