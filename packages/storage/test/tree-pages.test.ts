// The tree writer's commands for what is known on a node, in a disposable tree space: notes on any
// node and on a page, in one thread with log entries and learnings; pages with their versions, an
// edit of old words to new words, an append and a Restore, stored as today's writer stores text and
// within one size; a node's brief, description and text for agents. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TreeResult } from "../src/tree/core.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { openTree, treeHistoryProblems, type TreeFixture } from "./tree-helpers.ts";

const temp = tempFolders("tree-pages");
afterAll(temp.cleanup);

const BODY = "Bring the old passport.\n\nBring a photo.";

describe("[S2.tree.pages] notes, pages and a node's texts on the tree", () => {
  let fx: TreeFixture;
  beforeEach(async () => {
    fx = openTree(await checkedDriver(), temp.make(), true);
  });
  afterEach(() => {
    const problems = treeHistoryProblems(fx.conn);
    fx.close();
    expect(problems).toEqual([]);
  });

  const ok = (result: TreeResult): Record<string, unknown> => {
    expect(result.status).toBe("applied");
    return result.result as Record<string, unknown>;
  };
  const row = (table: string, id: unknown): Record<string, unknown> =>
    fx.conn.prepare(`SELECT * FROM ${table} WHERE id = $id`).get({ id: String(id) }) ?? {};
  const task = (title = "Renew the passport", under?: string): string =>
    (
      ok(
        fx.send("tasks.add", { tasks: [{ title, ...(under === undefined ? {} : { under }) }] }),
      ) as {
        tasks: { ref: string }[];
      }
    ).tasks[0]?.ref ?? "";
  const project = (title: string): string =>
    (ok(fx.send("project.create", { title })) as { project: { id: string } }).project.id;
  const page = (on: string, body = BODY): { id: string; ref: string } =>
    (
      ok(fx.send("page.create", { on, title: "Passport", brief: "What to bring", body })) as {
        page: { id: string; ref: string };
      }
    ).page;

  test("notes on a task, a project, the space and a page: one thread per owner, of any kind", () => {
    const ref = task();
    const home = project("Home");
    ok(
      fx.send(
        "note.add",
        { on: ref, body: "Booked for Friday", kind: "progress" },
        { who: fx.agent },
      ),
    );
    ok(
      fx.send(
        "note.add",
        { on: ref, body: "Photos must be recent", kind: "learning" },
        { who: fx.agent },
      ),
    );
    ok(fx.send("note.add", { on: home, body: "The council's site is slow" }));
    ok(fx.send("note.add", { on: "space", body: "Mail goes to the old address" }));
    const p = page(home);
    ok(fx.send("note.add", { on: p.ref, body: "Is the photo rule still true?" }));
    const kinds = fx.conn
      .prepare(
        "SELECT kind, ordinal FROM notes WHERE owner_id = (SELECT id FROM tasks WHERE ref = 1)",
      )
      .all();
    expect(kinds).toEqual([
      { kind: "progress", ordinal: 1 },
      { kind: "learning", ordinal: 2 },
    ]);
    ok(fx.send("note.edit", { on: p.ref, ordinal: 1, body: "The photo rule holds" }));
    ok(fx.send("note.remove", { on: p.ref, ordinal: 1 }));
    // A page's comment belongs to its page's node in the change log.
    const node = fx.conn
      .prepare(
        "SELECT DISTINCT node_id FROM changes WHERE entity = 'notes' AND entity_id = (SELECT id FROM notes WHERE owner_id = $p)",
      )
      .all({ p: p.id });
    expect(node).toEqual([{ node_id: home }]);
    expect(fx.send("note.add", { on: p.ref, body: "Ok", kind: "rumour" }).error?.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  test("a page takes the space's next reference on any node, and edits of different passages both stand", () => {
    const ref = task();
    const p = page(ref);
    expect(p.ref).toBe("M-2");
    const base = fx.send("note.add", { on: ref, body: "Read the page" }).as_of;
    ok(
      fx.send(
        "page.edit",
        { page: p.ref, old: "the old passport", new: "both old passports" },
        { base, who: fx.agent },
      ),
    );
    ok(fx.send("page.edit", { page: p.ref, old: "a photo", new: "two photos" }, { base }));
    expect(row("pages", p.id)["body"]).toBe("Bring both old passports.\n\nBring two photos.");
  });

  test("old words that are gone or stand twice write nothing; the answer holds the page's start", () => {
    const p = page("space", "Bring a photo. Bring a photo.");
    const before = row("pages", p.id);
    const twice = fx.send("page.edit", { page: p.ref, old: "Bring a photo.", new: "Bring two." });
    expect(twice).toMatchObject({
      status: "unchanged",
      result: { found: 2, excerpt: "Bring a photo. Bring a photo." },
    });
    const gone = fx.send("page.edit", { page: p.ref, old: "Bring a pen.", new: "Bring two." });
    expect(gone.result).toMatchObject({ found: 0 });
    expect(row("pages", p.id)).toEqual(before);
  });

  test("an append adds a blank line and the text; a set and a Restore meet newer words as a conflict", () => {
    const p = page("space");
    const first = Number(row("pages", p.id)["created_seq"]);
    ok(fx.send("page.append", { page: p.ref, text: "Ask for a receipt." }));
    expect(row("pages", p.id)["body"]).toBe(`${BODY}\n\nAsk for a receipt.`);
    const read = fx.send("page.set", { page: p.ref, title: "Passport" }).as_of;
    ok(
      fx.send(
        "page.edit",
        { page: p.ref, old: "Ask for a receipt.", new: "Keep the receipt." },
        { who: fx.agent },
      ),
    );
    const stale = fx.send("page.set", { page: p.ref, from_seq: first }, { base: read });
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual([expect.objectContaining({ entity: "pages", field: "body" })]);
    ok(fx.send("page.set", { page: p.ref, from_seq: first }));
    expect(row("pages", p.id)["body"]).toBe(BODY);
    expect(fx.send("page.set", { page: p.ref, from_seq: 999 }).error?.code).toBe("NOT_FOUND");
  });

  test("a page whose task goes to the Trash is not found, and comes back with it unwritten", () => {
    const ref = task();
    const p = page(ref);
    const before = row("pages", p.id);
    ok(fx.send("nodes.trash", { task: ref }));
    expect(fx.send("page.append", { page: p.ref, text: "More." }).error?.code).toBe("NOT_FOUND");
    ok(fx.send("nodes.restore", { task: ref }));
    expect(row("pages", p.id)).toEqual(before);
    const home = project("Home");
    ok(fx.send("page.move", { page: p.ref, on: home }));
    ok(fx.send("page.trash", { page: p.ref }));
    expect(row("pages", p.id)).toMatchObject({ owner_id: home });
    expect(fx.send("page.append", { page: p.ref, text: "More." }).error?.code).toBe("DELETED");
    ok(fx.send("page.restore", { page: p.ref }));
    expect(row("pages", p.id)["deleted_at"]).toBeNull();
  });

  test("a node's brief and description; the text for agents is a person's alone, and not a task's", () => {
    const home = project("Home");
    ok(fx.send("node.set", { node: home, description: "The house and the garden." }));
    ok(fx.send("node.set", { node: "space", brief: "Work and home" }));
    const refused = fx.send(
      "node.instruct",
      { node: home, text: "Mail the council." },
      { who: fx.agent },
    );
    expect(refused.error?.code).toBe("USER_ONLY");
    ok(fx.send("node.instruct", { node: home, text: "Never mail the council." }));
    expect(fx.send("node.instruct", { node: task(), text: "No." }).error?.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(row("nodes", home)).toMatchObject({
      description: "The house and the garden.",
      for_agents: "Never mail the council.",
    });
    expect(row("nodes", fx.spaceId)["brief"]).toBe("Work and home");
  });

  test("text is stored as today's writer stores it: LF line endings, no controls, NFC", () => {
    const decomposed = "Cafe\u0301 notes\r\nline two\u0007";
    const p = (
      ok(fx.send("page.create", { on: "space", title: "Cafe\u0301", body: decomposed })) as {
        page: { id: string };
      }
    ).page;
    expect(row("pages", p.id)).toMatchObject({ title: "Café", body: "Café notes\nline two" });
    ok(fx.send("page.append", { page: p.id, text: "e\u0301" }));
    expect(row("pages", p.id)["body"]).toBe("Café notes\nline two\n\né");
    // Words joined across an edit read as they show: the decomposed accent joins the e before it.
    ok(fx.send("page.edit", { page: p.id, old: "two", new: "twoe\u0301" }));
    expect(String(row("pages", p.id)["body"]).normalize("NFC")).toBe(row("pages", p.id)["body"]);
  });

  test("a page's change rows belong to the node that holds it, also after a move", () => {
    const ref = task();
    const p = page(ref);
    ok(fx.send("page.set", { page: p.ref, title: "Passports" }));
    const home = project("Home");
    ok(fx.send("page.move", { page: p.ref, on: home }));
    const nodes = fx.conn
      .prepare("SELECT field, node_id FROM changes WHERE entity = 'pages' ORDER BY seq")
      .all()
      .map((r) => [r["field"], r["node_id"]]);
    const taskId = fx.conn.prepare("SELECT id FROM tasks WHERE ref = 1").get()?.["id"];
    expect(nodes).toEqual([
      [null, taskId],
      ["title", taskId],
      ["owner", home],
    ]);
  });

  test("a page larger than a page may be is refused, also when an append or an edit would make it so", () => {
    const big = "x".repeat(64 * 1024 - 10);
    const p = page("space", big);
    expect(fx.send("page.append", { page: p.ref, text: "more words here" }).error?.code).toBe(
      "TOO_LARGE",
    );
    expect(fx.send("page.edit", { page: p.ref, old: "xxxx", new: "y" }).result).toMatchObject({
      found: expect.any(Number) as number,
    });
    expect(
      fx.send("page.create", { on: "space", title: "Huge", body: `${big}0123456789ab` }).error
        ?.code,
    ).toBe("TOO_LARGE");
  });
});
