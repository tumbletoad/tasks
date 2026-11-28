// Pages and a node's texts through the write path: a page takes the space's next reference, an edit
// replaces its old words only while they stand once in the body, so two edits of different
// passages both stand, and words that are gone or stand twice write nothing; a set and a Restore
// meet newer words as a conflict; a page leaves with its task and comes back with it, unwritten;
// only a person writes a node's text for agents. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import type { Credential, Operation, PageOwner, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkHistory, expectStatus, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("pages");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

const BODY = "## Steps\n\nBring a photo.\n\n## Fees\n\nPay at the desk.";

describe("[A1.5.pages.write] pages and a node's texts through the write path", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await fixture();
  });
  afterEach(() => {
    checkHistory(fx.reader);
    fx.close();
  });

  const submit = (ops: Operation[], who?: Credential, base?: string): WriteResult =>
    fx.writer.submit(fx.request(who ?? fx.codex, ops, { base: base ?? fx.base() }));
  const send = (ops: Operation[], who?: Credential): WriteResult => {
    const result = submit(ops, who);
    expectStatus(result, "applied");
    return result;
  };
  const page = (ref: string): Record<string, unknown> =>
    fx.reader.prepare("SELECT * FROM pages WHERE ref = $ref").get({ ref: Number(ref.slice(2)) }) ??
    {};
  const create = (owner: PageOwner, body = BODY): string =>
    send([{ kind: "page.create", owner, title: "Passport", brief: "What to bring", body }])
      .results[0]?.ref ?? "";
  const words = (word: string): string[] =>
    fx.reader
      .prepare(
        "SELECT d.entity_id FROM search_fts f JOIN search_docs d ON d.doc = f.rowid " +
          "WHERE search_fts MATCH $word",
      )
      .all<{ entity_id: string }>({ word: `"${word}"` })
      .map((row) => row.entity_id);

  test("a page takes the space's next reference, as a task does, on any holder", () => {
    const ref = create({ kind: "space" });
    const task = newId("t");
    const made = send([{ kind: "task.create", id: task, title: "Renew the passport" }]);
    expect(Number(made.results[0]?.ref?.slice(2))).toBe(Number(ref.slice(2)) + 1);
    for (const owner of [
      { kind: "area", area: fx.areas.lumen },
      { kind: "project", project: fx.project },
      { kind: "task", task },
    ] as const) {
      const on = create(owner);
      expect(page(on)).toMatchObject({ owner_kind: owner.kind, title: "Passport" });
    }
    expect(page(ref)).toMatchObject({
      owner_kind: "space",
      owner_id: fx.spaceId,
      brief: "What to bring",
    });
    expect(words("photo")).toContain(page(ref)["id"]);
  });

  test("two edits of different passages, sent from the same read, both stand", () => {
    const ref = create({ kind: "space" });
    const read = fx.base();
    expectStatus(
      submit(
        [{ kind: "page.edit", page: ref, old: "Bring a photo.", new: "Bring two photos." }],
        fx.codex,
        read,
      ),
      "applied",
    );
    expectStatus(
      submit(
        [{ kind: "page.edit", page: ref, old: "Pay at the desk.", new: "Pay online first." }],
        fx.claude,
        read,
      ),
      "applied",
    );
    expect(page(ref)["body"]).toBe("## Steps\n\nBring two photos.\n\n## Fees\n\nPay online first.");
    expect(words("online")).toEqual([page(ref)["id"]]);
  });

  test("words that are gone or stand twice write nothing, and the answer holds the page's start", () => {
    const ref = create({ kind: "space" }, `${BODY}\n\nBring a photo.`);
    const before = page(ref);
    const gone = submit([{ kind: "page.edit", page: ref, old: "Bring a pen.", new: "Bring two." }]);
    expectStatus(gone, "unchanged");
    expect(gone.results[0]).toMatchObject({ found: 0, excerpt: before["body"] });
    const twice = submit([
      { kind: "page.edit", page: ref, old: "Bring a photo.", new: "Bring two." },
    ]);
    expect(twice.results[0]).toMatchObject({ found: 2 });
    expect(page(ref)).toEqual(before);
  });

  test("an append adds a blank line and the text; a set and a Restore meet newer words as a conflict", () => {
    const ref = create({ kind: "space" });
    const first = Number(page(ref)["created_seq"]);
    send([{ kind: "page.append", page: ref, text: "Ask for a receipt." }]);
    expect(page(ref)["body"]).toBe(`${BODY}\n\nAsk for a receipt.`);
    const read = fx.base();
    send(
      [{ kind: "page.edit", page: ref, old: "Ask for a receipt.", new: "Keep the receipt." }],
      fx.claude,
    );
    const stale = submit([{ kind: "page.set", page: ref, from_seq: first }], fx.human, read);
    expectStatus(stale, "conflict");
    expect(stale.conflicts).toEqual([expect.objectContaining({ entity: "pages", field: "body" })]);
    send([{ kind: "page.set", page: ref, from_seq: first }], fx.human);
    expect(page(ref)["body"]).toBe(BODY);
    const none = submit([{ kind: "page.set", page: ref, from_seq: 1 }], fx.human);
    expect(none.error?.code).toBe("NOT_FOUND");
  });

  test("a page whose task goes to the Trash is not found, keeps its version and comes back with it", () => {
    const task = newId("t");
    send([{ kind: "task.create", id: task, title: "Renew the passport" }]);
    const ref = create({ kind: "task", task });
    const before = page(ref);
    send([{ kind: "task.delete", task }], fx.human);
    expect(page(ref)).toEqual(before);
    expect(submit([{ kind: "page.append", page: ref, text: "More." }]).error?.code).toBe(
      "NOT_FOUND",
    );
    expect(words("photo")).toEqual([]);
    send([{ kind: "task.restore", task }], fx.human);
    expect(words("photo")).toEqual([before["id"]]);
    send([{ kind: "page.move", page: ref, owner: { kind: "project", project: fx.project } }]);
    send([{ kind: "page.trash", page: ref }]);
    expect(page(ref)["owner_kind"]).toBe("project");
    expect(page(ref)["deleted_at"]).not.toBeNull();
    expect(submit([{ kind: "page.append", page: ref, text: "More." }]).error?.code).toBe("DELETED");
    send([{ kind: "page.restore", page: ref }]);
    expect(page(ref)["deleted_at"]).toBeNull();
  });

  test("a node's texts: a description and the space's brief; the text for agents is a person's alone", () => {
    const node = { kind: "project", project: fx.project } as const;
    send([{ kind: "node.set", node, description: "The clinic group's portal." }]);
    send([{ kind: "node.set", node: { kind: "space" }, brief: "Work and home" }]);
    const refused = submit([{ kind: "node.instruct", node, text: "Mail the clinic." }], fx.codex);
    expect(refused.error?.code).toBe("USER_ONLY");
    send([{ kind: "node.instruct", node, text: "Never mail the clinic." }], fx.human);
    const texts = fx.reader.prepare("SELECT * FROM node_texts ORDER BY owner_kind").all();
    expect(texts).toEqual([
      expect.objectContaining({
        owner_kind: "project",
        description: "The clinic group's portal.",
        for_agents: "Never mail the clinic.",
      }),
      expect.objectContaining({ owner_kind: "space", brief: "Work and home" }),
    ]);
    expect(words("portal")).toContain(fx.project);
  });

  test("a page's write is a request of its own", () => {
    const result = submit([
      { kind: "page.create", owner: { kind: "space" }, title: "Passport", brief: "", body: "" },
      { kind: "task.create", id: newId("t"), title: "Renew the passport" },
    ]);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });
});
