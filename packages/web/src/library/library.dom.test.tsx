// @vitest-environment happy-dom
//
// The library's screens with the real live store, rendered by React into a DOM (happy-dom), against
// the contract's examples: a project's Library, a page with its versions, Show and Restore, the
// pen, the feed while a page is open, and the pages in the Trash. Fixture text only.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  PAGE_CONFLICT_EXAMPLE,
  PAGE_FEED_EXAMPLES,
  pageHistory,
  pageRead,
  pageTrashed,
} from "@ttasks/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import type { SnapshotMessage } from "../store/rows.ts";
import { TrashedPages } from "./TrashedPages.tsx";
import { NodeLibrary } from "./Library.tsx";
import { PageScreen } from "./PageScreen.tsx";
import { FakeFrames } from "../../test/fake-frames.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const [pageExample, nodeExample] = pageRead.examples.map((e) => e.output) as unknown as [
  Record<string, unknown> & { id: string; ref: string; version: number; body: string },
  Record<string, unknown> & {
    id: string;
    above: { id: string }[];
    for_agents: { text: string };
  },
];
const [versionsExample, versionExample] = pageHistory.examples.map((e) => e.output) as unknown as [
  { versions: { seq: number }[] },
  { text: string; version: { seq: number } },
];
const PROJECT = nodeExample.id;
const AREA = nodeExample.above[0]?.id ?? "";
const SPACE_ID = nodeExample.above[1]?.id ?? "";
/** The page as the screen reads it: whole, not one section. */
const PAGE = { ...pageExample, section: undefined };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 1045 };
const AS_OF = "1.1046.5n0w8k3q";

const snapshot = {
  type: "snapshot",
  space: { id: SPACE_ID, name: "Mira", ref_prefix: "M" },
  cursor: CURSOR,
  tasks: [],
  areas: [{ id: AREA, title: "Client work", position: "a" }],
  projects: [{ id: PROJECT, area_id: AREA, title: "Lumen Health", position: "a" }],
  pages: PAGE_FEED_EXAMPLES.snapshotPages,
  instances: [
    { key: "codex-work", app: "Codex", label: "Codex", glyph: "C", ring: 1, route: "terminal" },
    { key: "claude-code", app: "Claude", label: "Claude", glyph: "Cl", ring: 2, route: "terminal" },
  ],
} as unknown as SnapshotMessage;

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;
/** Every library call, by name, with its input. */
let calls: [string, Record<string, unknown>][];
/** Answers page.read of a node. */
let nodeRead: (input: Record<string, unknown>) => unknown;
/** Answers page.write: the next write's answer, or its refusal. */
let written: () => Promise<unknown>;

beforeEach(() => {
  calls = [];
  nodeRead = () => nodeExample;
  localStorage.clear();
  written = () => Promise.resolve({ result: "set", target: PAGE.ref, as_of: "1.1047.5n0w8k3q" });
  const record =
    (name: string, answer: (input: Record<string, unknown>) => Promise<unknown>) =>
    (input: Record<string, unknown>) => {
      calls.push([name, input]);
      return answer(input);
    };
  api = {
    client: {
      receipt: { get: () => new Promise(() => undefined) },
      page: {
        read: record("page.read", (input) =>
          Promise.resolve(input["target"] === PAGE.ref ? PAGE : nodeRead(input)),
        ),
        history: record("page.history", (input) =>
          Promise.resolve(input["seq"] === undefined ? versionsExample : versionExample),
        ),
        trashed: record("page.trashed", () => Promise.resolve(pageTrashed.examples[0]?.output)),
        write: record("page.write", () => written()),
      },
      node: {
        instruct: record("node.instruct", () =>
          Promise.resolve({ result: "set", target: PROJECT, as_of: "1.1047.5n0w8k3q" }),
        ),
      },
    },
    busy: () => Promise.resolve({ busy: [], last: {} }),
    receipts: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
  } as unknown as Api;
  live = new Live({
    api,
    route: { space: SPACE_ID },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames: new FakeFrames(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
  vi.restoreAllMocks();
});

/** Renders `node` with its messages, its session and a router, at `at` with `state` in its entry. */
async function mount(node: ReactNode, at = "/", state?: Record<string, unknown>) {
  const history = createMemoryHistory({ initialEntries: [at] });
  if (state !== undefined) history.replace(at, state);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <I18n>
          <Session.Provider value={{ api, live }}>{node}</Session.Provider>
        </I18n>
      ),
    }),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  feed(snapshot);
  await settle();
  return router;
}

function feed(message: unknown) {
  act(() => {
    live.store.push(message as SnapshotMessage);
    live.store.flush();
  });
}

/** A batch of the feed that carries `events`, from the cursor `from` on. */
const batchOf = (from: number, events: readonly unknown[]) => ({
  type: "batch",
  space_id: SPACE_ID,
  epoch: CURSOR.epoch,
  incarnation: CURSOR.incarnation,
  from,
  through: (events.at(-1) as { readonly seq: number } | undefined)?.seq ?? from,
  events,
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`);
const parts = (name: string) => [
  ...container.querySelectorAll<HTMLElement>(`[data-part="${name}"]`),
];
const named = (name: string) =>
  [...container.querySelectorAll<HTMLElement>("button, a")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
const click = async (element: Element | null | undefined) => {
  act(() => {
    (element as HTMLElement | null | undefined)?.click();
  });
  await settle();
};
const reads = (target: string) =>
  calls.filter(([name, input]) => name === "page.read" && input["target"] === target).length;

function type(box: HTMLTextAreaElement, words: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, words);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = (target: Element | null, key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
};

describe("[A5.pages.web.library] a project's Library against the contract's examples", () => {
  test("its texts, its pages and its tasks' pages, each row to its page; a page an agent moves to the Trash leaves, and a change to the texts reads them again", async () => {
    await mount(<NodeLibrary node={{ kind: "project", id: PROJECT }} />);
    expect(part("node-brief")?.textContent).toContain(String(nodeExample["brief"]));
    expect(part("for-agents")?.textContent).toContain(nodeExample.for_agents.text);
    expect(part("description")?.textContent).toContain("weekly report");
    const rows = parts("page-row");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      `/s/${SPACE_ID}/page/M-180`,
      `/s/${SPACE_ID}/page/M-221`,
    ]);
    expect(rows[0]?.textContent).toContain("Time zone rules");
    expect(rows[0]?.textContent).toContain("Codex");
    expect(rows[1]?.textContent).toContain("M-14");
    expect(part("from-above")?.textContent).toContain("Client work");

    feed(batchOf(CURSOR.seq, [PAGE_FEED_EXAMPLES.pageLeaves]));
    expect(parts("page-row").map((row) => row.getAttribute("href"))).toEqual([
      `/s/${SPACE_ID}/page/M-221`,
    ]);

    const before = reads(PROJECT);
    feed(batchOf(PAGE_FEED_EXAMPLES.pageLeaves.seq, [PAGE_FEED_EXAMPLES.textChanged]));
    await settle();
    expect(reads(PROJECT)).toBe(before + 1);
  });

  test("a change to the texts while the person reads them is offered, not put in their place; a long description is read whole", async () => {
    const [first, rest] = [
      "The portal of the clinic group: ",
      "booking, reminders and the weekly report.",
    ];
    nodeRead = (input) =>
      input["cursor"] === undefined
        ? {
            ...nodeExample,
            description: first,
            slice: { from: 0, to: first.length, of: first.length + rest.length },
            cursor: "c1",
          }
        : {
            ...nodeExample,
            description: rest,
            slice: {
              from: first.length,
              to: first.length + rest.length,
              of: first.length + rest.length,
            },
          };
    await mount(<NodeLibrary node={{ kind: "project", id: PROJECT }} />);
    expect(part("description")?.textContent).toContain(first + rest);
    // The whole description is read: its pen opens.
    expect(named("Edit the description")?.getAttribute("aria-disabled")).toBeNull();

    nodeRead = () => ({ ...nodeExample, description: "Rewritten by an agent." });
    feed(batchOf(CURSOR.seq, [{ ...PAGE_FEED_EXAMPLES.textChanged, seq: CURSOR.seq + 1 }]));
    await settle();
    expect(part("description")?.textContent).toContain(first + rest);
    await click(part("texts-newer")?.querySelector("button"));
    expect(part("description")?.textContent).toContain("Rewritten by an agent.");
    expect(part("texts-newer")).toBeNull();
  });

  test("the person writes the text for agents with the pen, from the base the Library read", async () => {
    await mount(<NodeLibrary node={{ kind: "project", id: PROJECT }} />);
    await click(named("Edit the text for agents"));
    const box = part("text-edit") as HTMLTextAreaElement;
    expect(box.value).toBe(nodeExample.for_agents.text);
    type(box, "Drafts come to me; never mail the clinic.");
    press(box, "Enter");
    await settle();
    expect(calls.find(([name]) => name === "node.instruct")?.[1]).toMatchObject({
      target: PROJECT,
      text: "Drafts come to me; never mail the clinic.",
      base: AS_OF,
    });
  });
});

describe("[A5.pages.web.new-page] the person makes a page with its title alone", () => {
  test("New page asks for a title, makes the page without a brief and opens it with the pen in its body; a row without a brief has no brief line", async () => {
    written = () =>
      Promise.resolve({ result: "created", target: "M-230", as_of: "1.1047.5n0w8k3q" });
    const router = await mount(<NodeLibrary node={{ kind: "project", id: PROJECT }} />);
    await click(part("new-page"));
    const field = part("new-page-title") as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "Clinic contacts",
      );
    });
    press(field, "Enter");
    await settle();
    const made = calls.find(([name]) => name === "page.write")?.[1];
    expect(made).toMatchObject({ action: "create", on: PROJECT, title: "Clinic contacts" });
    expect(made).not.toHaveProperty("brief");
    expect(router.state.location.pathname).toBe(`/s/${SPACE_ID}/page/M-230`);
    expect(router.state.location.state.pen).toBe("body");

    const [row] = PAGE_FEED_EXAMPLES.snapshotPages;
    feed(
      batchOf(CURSOR.seq, [
        {
          seq: 1046,
          request_id: "r1046",
          actor: { kind: "human", label: "user" },
          kind: "ops",
          entities: [
            {
              type: "page",
              id: "pg_7c1g5k9p3t7x1b5f9k3p7t1x5c",
              row: {
                ...row,
                id: "pg_7c1g5k9p3t7x1b5f9k3p7t1x5c",
                ref: "M-230",
                title: "Clinic contacts",
                brief: "",
                version: 1046,
              },
              changed: [],
              created: true,
            },
          ],
        },
      ]),
    );
    const made230 = parts("page-row").find((r) => r.textContent.includes("Clinic contacts"));
    expect(made230?.querySelector('[class*="brief"]')).toBeNull();
    const m180 = parts("page-row").find((r) => r.textContent.includes("Time zone rules"));
    expect(m180?.querySelector('[class*="brief"]')?.textContent).toContain("Store UTC");
  });

  test("a page the person just made opens with its body's pen", async () => {
    await mount(<PageScreen page={PAGE.ref} />, "/s/x/page/M-180", { pen: "body" });
    expect(part("text-edit")).not.toBeNull();
    expect(part("text-edit")?.tagName).toBe("TEXTAREA");
  });
});

describe("[A5.pages.web.page] a page's screen against the contract's examples", () => {
  test("who changed it, the way back to where the person came from, its versions with Show and Restore", async () => {
    await mount(<PageScreen page={PAGE.ref} />, "/s/x/page/M-180", {
      from: {
        path: `/s/${SPACE_ID}/area/${AREA}/project/${PROJECT}/library`,
        label: "Lumen Health · Library",
      },
    });
    expect(part("page-changed")?.textContent).toContain("Changed by Codex");
    expect(part("page-changed")?.textContent).toContain("store the zone ID");
    expect(part("page-back")?.textContent).toBe("Lumen Health · Library");
    expect(part("page-body")?.querySelector("h3")?.textContent).toBe("Pitfalls");

    await click(part("versions-toggle"));
    expect(parts("version")).toHaveLength(versionsExample.versions.length);
    // The newest version is the page as it is: nothing to show or restore.
    expect(parts("version")[0]?.querySelector("button")).toBeNull();

    await click(parts("version-show")[0]);
    expect(calls.at(-1)).toEqual([
      "page.history",
      { target: PAGE.ref, seq: versionsExample.versions[1]?.seq },
    ]);
    expect(part("page-version")?.textContent).toContain(
      "Store every appointment in UTC. Convert when shown.",
    );
    expect(part("page-body")).toBeNull();

    await click(part("restore-shown"));
    expect(calls.find(([name]) => name === "page.write")?.[1]).toMatchObject({
      action: "set",
      target: PAGE.ref,
      from_seq: versionsExample.versions[1]?.seq,
      base: AS_OF,
    });
    // Written back: the current words again, read anew, with the focus on them.
    expect(part("page-version")).toBeNull();
    expect(reads(PAGE.ref)).toBe(2);
    expect(document.activeElement).toBe(part("page-words"));
  });

  test("a Restore that meets a newer body writes nothing and goes back to the current words, read anew, before Restore can be pressed again", async () => {
    written = () =>
      Promise.reject(
        Object.assign(new Error(PAGE_CONFLICT_EXAMPLE.message), PAGE_CONFLICT_EXAMPLE),
      );
    await mount(<PageScreen page={PAGE.ref} />);
    await click(part("versions-toggle"));
    await click(parts("version-show")[0]);
    await click(part("restore-shown"));
    expect(reads(PAGE.ref)).toBe(2);
    // The old version is no longer on screen: its Restore is not there to press over unseen words.
    expect(part("page-version")).toBeNull();
    expect(part("restore-shown")).toBeNull();
    expect(part("page-body")).not.toBeNull();
    expect(calls.filter(([name]) => name === "page.write")).toHaveLength(1);
  });

  test("the feed never moves the reader's words: a newer change shows a line, and an open pen keeps what was typed", async () => {
    await mount(<PageScreen page={PAGE.ref} />);
    await click(named("Edit the page"));
    const box = part("text-edit") as HTMLTextAreaElement;
    type(box, "My own words, half typed");
    // Enter is a new line in a page's body: nothing is sent.
    press(box, "Enter");
    expect(calls.some(([name]) => name === "page.write")).toBe(false);

    const [row] = PAGE_FEED_EXAMPLES.snapshotPages;
    feed(
      batchOf(CURSOR.seq, [
        {
          seq: 1046,
          request_id: "r1046",
          actor: { kind: "agent", label: "codex-work" },
          kind: "ops",
          entities: [
            {
              type: "page",
              id: PAGE.id,
              row: { ...row, version: 1046 },
              changed: ["body"],
              created: false,
            },
          ],
        },
      ]),
    );
    await settle();
    expect((part("text-edit") as HTMLTextAreaElement).value).toBe("My own words, half typed");
    expect(part("page-newer")?.textContent).toContain("Codex");
    expect(reads(PAGE.ref)).toBe(1);

    press(part("text-edit"), "Enter", { ctrlKey: true });
    await settle();
    expect(calls.find(([name]) => name === "page.write")?.[1]).toMatchObject({
      action: "set",
      target: PAGE.ref,
      body: "My own words, half typed",
      base: AS_OF,
    });
  });
});

describe("[A5.pages.web.trash] the pages in the Trash", () => {
  test("each with where it was, who moved it and why, and its own Restore", async () => {
    await mount(<TrashedPages q="" />);
    const [page] = parts("trashed-page");
    expect(page?.textContent).toContain("Time zone rules");
    expect(page?.textContent).toContain("Lumen Health");
    expect(page?.textContent).toContain("merged into M-140");
    written = () =>
      Promise.resolve({ result: "restored", target: "M-180", as_of: "1.1047.5n0w8k3q" });
    await click(named("Restore M-180"));
    expect(calls.find(([name]) => name === "page.write")?.[1]).toMatchObject({
      action: "restore",
      target: "M-180",
    });
    expect(parts("trashed-page")).toHaveLength(0);
  });
});
