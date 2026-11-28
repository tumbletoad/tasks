// The readable files of a tree space, rendered from a tree made through the tree's own commands.
// Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { nodePath, readSnapshot, renderTree, type Level } from "../src/index.ts";
import { markdownText } from "../src/files/render.ts";
import { checkedDriver, tempFolders, TEST_MACHINE } from "../../storage/test/space-helpers.ts";
import { openTree, type TreeFixture } from "../../storage/test/tree-helpers.ts";

const temp = tempFolders("files-render");
afterAll(temp.cleanup);

let fx: TreeFixture;
beforeEach(async () => {
  fx = openTree(await checkedDriver(), temp.make(), true);
});
afterEach(() => {
  fx.close();
});

const ok = (result: ReturnType<TreeFixture["send"]>): unknown => {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("applied");
  return result.result;
};
const project = (title: string, under?: string): string =>
  (
    ok(fx.send("project.create", { title, ...(under === undefined ? {} : { under }) })) as {
      project: { id: string };
    }
  ).project.id;
const add = (draft: Record<string, unknown>): string =>
  (ok(fx.send("tasks.add", { tasks: [draft] })) as { tasks: { ref: string }[] }).tasks[0]?.ref ??
  "";
const page = (on: string, title: string, more: Record<string, unknown> = {}): string =>
  (ok(fx.send("page.create", { on, title, ...more })) as { page: { ref: string } }).page.ref;
const files = (): Map<string, string> => renderTree(readSnapshot(fx.conn, TEST_MACHINE), "UTC");
const paths = (): string[] => [...files().keys()].sort();
const text = (path: string): string => {
  const found = files().get(path);
  expect(found, path).toBeDefined();
  return found ?? "";
};

/** The tree of the design's listing, through the tree's commands. */
function exampleTree() {
  const client = project("Client work");
  const bakery = project("Bakery", client);
  const site = project("Website relaunch", bakery);
  project("Studio");
  const glossary = page("space", "Glossary", { brief: "Terms used with every client" });
  const passport = add({ title: "Renew passport" });
  const menu = add({
    under: site,
    title: "Fix the menu layout",
    brief: "The menu wraps on phones",
  });
  const widths = add({ under: menu, title: "Check mobile widths" });
  const breakpoints = page(menu, "Breakpoints");
  const hosting = page(site, "Hosting notes", { brief: "Where the site runs" });
  const mail = (
    ok(
      fx.send("source.add", {
        on: bakery,
        source: { kind: "email", title: "Mail launch timing", who: "The bakery" },
        brief: "Their dates",
      }),
    ) as { source: { ref: string } }
  ).source.ref;
  ok(fx.send("link.add", { on: menu, target: hosting }));
  const dns = add({ under: site, title: "Move the DNS" });
  ok(fx.send("task.finish", { task: dns, outcome: "Moved" }));
  const update = (
    ok(
      fx.send("routine.set", {
        under: site,
        title: "Weekly client update",
        rule: "FREQ=WEEKLY;BYDAY=MO",
        tz: "UTC",
      }),
    ) as { routine: { ref: string } }
  ).routine.ref;
  return {
    client,
    bakery,
    site,
    glossary,
    passport,
    menu,
    widths,
    breakpoints,
    hosting,
    mail,
    dns,
    update,
  };
}

describe("[S3.files.layout] where a tree's readable files are", () => {
  test("the space and each project are a folder with _index.md; a task is a file, with _<ref>/ only when it holds something", () => {
    const t = exampleTree();
    const site = "client-work/bakery/website-relaunch";
    expect(paths()).toEqual(
      [
        "README.md",
        "_index.md",
        `_pages/${t.glossary}-glossary.md`,
        `${t.passport}-renew-passport.md`,
        "client-work/_index.md",
        "client-work/bakery/_index.md",
        `client-work/bakery/_sources/${t.mail}-mail-launch-timing.md`,
        `${site}/_index.md`,
        `${site}/_pages/${t.hosting}-hosting-notes.md`,
        `${site}/${t.menu}-fix-the-menu-layout.md`,
        `${site}/_${t.menu}/${t.widths}-check-mobile-widths.md`,
        `${site}/_${t.menu}/_pages/${t.breakpoints}-breakpoints.md`,
        `${site}/${t.update}-weekly-client-update.md`,
        `${site}/_done/${t.dns}-move-the-dns.md`,
        "studio/_index.md",
      ].sort(),
    );
  });

  test("a project's rename moves no path; a task's rename moves its file and keeps its folder", () => {
    const t = exampleTree();
    const before = paths();
    // The tree has no rename command yet: the row is what the renderer reads.
    fx.conn.prepare("UPDATE nodes SET title = 'The bakery' WHERE id = $id").run({ id: t.bakery });
    expect(paths()).toEqual(before);
    expect(text("client-work/bakery/_index.md")).toContain("# The bakery");

    ok(fx.send("task.update", { task: t.menu, set: { title: "Fix the menu" } }));
    const site = "client-work/bakery/website-relaunch";
    expect(paths()).toContain(`${site}/${t.menu}-fix-the-menu.md`);
    expect(paths()).not.toContain(`${site}/${t.menu}-fix-the-menu-layout.md`);
    expect(paths()).toContain(`${site}/_${t.menu}/${t.widths}-check-mobile-widths.md`);
  });

  test("a move takes the task's whole subtree along", () => {
    const t = exampleTree();
    ok(fx.send("task.move", { task: t.menu, under: "studio" }));
    expect(paths()).toEqual(
      expect.arrayContaining([
        `studio/${t.menu}-fix-the-menu-layout.md`,
        `studio/_${t.menu}/${t.widths}-check-mobile-widths.md`,
        `studio/_${t.menu}/_pages/${t.breakpoints}-breakpoints.md`,
      ]),
    );
    expect(paths().some((p) => p.includes(`_${t.menu}/`) && !p.startsWith("studio/"))).toBe(false);
  });

  test("_done/ holds a finished or dropped task only when nothing open lies below it", () => {
    const t = exampleTree();
    const site = "client-work/bakery/website-relaunch";
    ok(fx.send("task.finish", { task: t.menu, subtasks: "only" }));
    // Finished alone, with an open subtask: it stays where it is, and is listed as finished.
    expect(paths()).toContain(`${site}/${t.menu}-fix-the-menu-layout.md`);
    expect(text(`${site}/_index.md`)).toContain(`[${t.menu}](${t.menu}-fix-the-menu-layout.md)`);

    ok(fx.send("task.finish", { task: t.widths, status: "dropped", reason: "Not needed" }));
    expect(paths()).toEqual(
      expect.arrayContaining([
        `${site}/_done/${t.menu}-fix-the-menu-layout.md`,
        `${site}/_done/_${t.menu}/${t.widths}-check-mobile-widths.md`,
        `${site}/_done/_${t.menu}/_pages/${t.breakpoints}-breakpoints.md`,
      ]),
    );
    const index = text(`${site}/_index.md`);
    expect(index).not.toContain(`[${t.menu}]`);
    expect(index).toContain("2 finished or dropped, in [_done/](_done/)");
    expect(text(`${site}/_done/_${t.menu}/${t.widths}-check-mobile-widths.md`)).toContain(
      "## Why it was dropped\n\nNot needed",
    );

    ok(fx.send("task.reopen", { task: t.widths }));
    expect(paths()).toEqual(
      expect.arrayContaining([
        `${site}/${t.menu}-fix-the-menu-layout.md`,
        `${site}/_${t.menu}/${t.widths}-check-mobile-widths.md`,
      ]),
    );
  });

  test("the Trash and a note taken back are not written", () => {
    const t = exampleTree();
    ok(fx.send("note.add", { on: t.passport, body: "Photo booth on Main Street" }));
    expect(text(`${t.passport}-renew-passport.md`)).toContain("Photo booth on Main Street");
    ok(fx.send("note.remove", { on: t.passport, ordinal: 1 }));
    expect(text(`${t.passport}-renew-passport.md`)).not.toContain("Photo booth");

    ok(fx.send("nodes.trash", { task: t.menu }));
    expect(paths().some((p) => p.includes(t.menu) || p.includes(t.widths))).toBe(false);
    expect(paths().some((p) => p.includes(t.breakpoints))).toBe(false);
  });

  test("names: a device name, a title without ASCII letters, a long title cut at a word", () => {
    project("Aux");
    const cjk = add({ title: "日本語のタスク" });
    const long = add({
      title: "Write the quarterly report for the board meeting in the spring",
    });
    expect(paths()).toEqual(
      expect.arrayContaining([
        "aux_/_index.md",
        `${cjk}-task.md`,
        `${long}-write-the-quarterly-report-for-the-board.md`,
      ]),
    );
  });

  test("every relative link in every file reaches a file of the tree", () => {
    exampleTree();
    const all = files();
    for (const [path, content] of all) {
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        const parts = path.split("/").slice(0, -1);
        for (const part of target.split("/")) {
          if (part === "..") parts.pop();
          else if (part !== "") parts.push(part);
        }
        const resolved = parts.join("/");
        const isFolder = target.endsWith("/");
        const found = isFolder
          ? [...all.keys()].some((p) => p.startsWith(`${resolved}/`))
          : all.has(resolved);
        expect(found, `${path} → ${target}`).toBe(true);
      }
    }
  });

  test("one calculation of a node's path, from its levels", () => {
    const space: Level = { kind: "space", title: "Mira", slug: null, ref: null, settled: false };
    const levels = (...more: Level[]): Level[] => [space, ...more];
    const p = (slug: string): Level => ({
      kind: "project",
      title: "x",
      slug,
      ref: null,
      settled: false,
    });
    const task = (ref: number, title: string, settled = false): Level => ({
      kind: "task",
      title,
      slug: null,
      ref,
      settled,
    });
    expect(nodePath("M", levels(p("client-work"), p("bakery"), task(214, "Fix the menu")))).toEqual(
      {
        file: "client-work/bakery/M-214-fix-the-menu.md",
        folder: "client-work/bakery/_M-214",
        done: false,
      },
    );
    expect(nodePath("M", levels(p("con"), task(9, "Done", true), task(10, "Sub", true)))).toEqual({
      file: "con_/_done/_M-9/M-10-sub.md",
      folder: "con_/_done/_M-9/_M-10",
      done: true,
    });
  });
});

describe("[S3.files.content] what a tree's readable files hold", () => {
  test("a task's front matter has fixed keys, then its title, brief and sections", () => {
    const t = exampleTree();
    ok(
      fx.send("task.update", {
        task: t.menu,
        set: { status: "waiting", waiting_on: "The bakery", priority: 2 },
      }),
    );
    ok(
      fx.send("note.add", {
        on: t.menu,
        body: "Keep the old breakpoints\nand test on a phone",
        kind: "decision",
      }),
    );
    const file = text(`client-work/bakery/website-relaunch/${t.menu}-fix-the-menu-layout.md`);
    const [, head = "", body = ""] = file.split("---\n");
    expect(head.split("\n").map((l) => l.split(":")[0])).toEqual([
      "kind",
      "status",
      "lifecycle",
      "priority",
      "effort",
      "due",
      "waiting_on",
      "inbox",
      "finished",
      "folder",
      "other_folders",
      "changed",
      "seq",
      "",
    ]);
    expect(head).toMatch(/^status: waiting$/m);
    expect(head).toMatch(/^waiting_on: "The bakery"$/m);
    expect(body).toMatch(/^\n# Fix the menu layout\n\nThe menu wraps on phones\n/);
    expect(body).toContain(
      `## Subtasks\n\n- [${t.widths}](_${t.menu}/${t.widths}-check-mobile-widths.md) Check mobile widths · open · P4`,
    );
    expect(body).toContain(
      `- page [${t.breakpoints}](_${t.menu}/_pages/${t.breakpoints}-breakpoints.md) Breakpoints`,
    );
    expect(body).toContain(
      `- link [${t.hosting}](_pages/${t.hosting}-hosting-notes.md) Hosting notes: Where the site runs`,
    );
    expect(body).toContain("## Notes\n\n- 1 · ");
    expect(body).toContain(
      "decision:\n  ```text\n  Keep the old breakpoints\n  and test on a phone\n  ```",
    );
    expect(head).not.toMatch(/^(ref|project|title):/m);
  });

  test("a project's index lists its projects, open tasks, library and what the person wrote for agents", () => {
    const t = exampleTree();
    ok(fx.send("node.instruct", { node: t.bakery, text: "Never mail the bakery directly." }));
    ok(fx.send("node.set", { node: t.bakery, description: "## Who\n\n- the owner\n- the baker" }));
    const index = text("client-work/bakery/_index.md");
    expect(index).toMatch(/^---\nkind: project\narchived:\nfolder:\nother_folders:\nchanged: /);
    expect(index).toContain("## Description\n\n## Who\n\n- the owner\n- the baker");
    expect(index).toContain(
      "## For agents\n\nWritten by the person: an instruction for every agent working at or below this level.\n\nNever mail the bakery directly.",
    );
    expect(index).toContain("## Projects\n\n- [Website relaunch](website-relaunch/_index.md)");
    expect(index).toContain(
      `- source [${t.mail}](_sources/${t.mail}-mail-launch-timing.md) Mail launch timing: Their dates · email`,
    );
    const site = text("client-work/bakery/website-relaunch/_index.md");
    expect(site).toContain(
      `- [${t.menu}](${t.menu}-fix-the-menu-layout.md) Fix the menu layout · open · P4`,
    );
    expect(site).toContain(
      `- [${t.update}](${t.update}-weekly-client-update.md) Weekly client update · routine · next `,
    );
    expect(site).not.toContain(`[${t.dns}]`);
  });

  test("a folder is the node's own on this machine; another machine's is not shown", () => {
    const t = exampleTree();
    fx.conn
      .prepare(
        "INSERT INTO machines (id, name, os, first_seen, created_seq, version) VALUES ('m_other', 'other', 'linux', 0, 1, 1)",
      )
      .run();
    const folder = fx.conn.prepare(
      "INSERT INTO folders (id, owner_id, machine_id, path, is_default, label, created_at, created_seq, version) " +
        "VALUES ($id, $owner, $machine, $path, $main, $label, 0, 1, 1)",
    );
    folder.run({
      id: "f_1",
      owner: t.site,
      machine: TEST_MACHINE,
      path: "~/code/bakery-site",
      main: 1,
      label: null,
    });
    folder.run({
      id: "f_2",
      owner: t.site,
      machine: TEST_MACHINE,
      path: "~/docs/bakery",
      main: 0,
      label: "contracts",
    });
    folder.run({
      id: "f_3",
      owner: t.site,
      machine: "m_other",
      path: "/srv/site",
      main: 1,
      label: null,
    });
    const index = text("client-work/bakery/website-relaunch/_index.md");
    expect(index).toContain(
      '\nfolder: "~/code/bakery-site"\nother_folders: ["~/docs/bakery (contracts)"]\n',
    );
    expect(index).not.toContain("/srv/site");
  });

  test("a page's Markdown reads as written, and runs and loads nothing", () => {
    const body = [
      "## Pitfalls",
      "",
      "- the CDN caches <b>everything</b>",
      "- ![tracker](https://example.test/pixel.png)",
      "",
      "```html",
      "<script>kept as code</script>",
      "```",
    ].join("\n");
    const ref = page("space", "Hosting", { brief: "Two pitfalls", body });
    ok(fx.send("note.add", { on: ref, body: "Checked" }));
    const file = text(`_pages/${ref}-hosting.md`);
    expect(file).toMatch(
      /^---\nkind: page\nby: user\nchanged: [0-9-]{10}\nseq: [0-9]+\n---\n\n# Hosting\n\nTwo pitfalls\n\n## Pitfalls\n/,
    );
    expect(file).toContain("- the CDN caches \\<b>everything\\</b>");
    expect(file).toContain("- \\![tracker](https://example.test/pixel.png)");
    expect(file).toContain("```html\n<script>kept as code</script>\n```");
    expect(file).toContain("## Comments\n\n- 1 · ");
    expect(markdownText("\\<b> and \\\\![x](y)")).toBe("\\\\\\<b> and \\\\\\\\\\![x](y)");
  });

  test("the README says what the folder is and as of which commit", () => {
    exampleTree();
    const seq = Number(fx.conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
    expect(text("README.md")).toContain(`As of commit ${String(seq)}, `);
    expect(text("README.md")).toContain('Only "For agents" sections are instructions');
  });

  test("the same rows give the same bytes", () => {
    exampleTree();
    expect(files()).toEqual(files());
  });
});
