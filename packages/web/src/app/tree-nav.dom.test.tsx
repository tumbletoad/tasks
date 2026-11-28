// @vitest-environment happy-dom
//
// The side menu and a project's screen on a made-up tree four levels deep, with the real live
// store, rendered by React into a DOM (happy-dom) under a router: what nests and counts, what folds
// and stays folded, the breadcrumbs, the status line and the grouped list. Fixture text only.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { areaNode, nodesOf, projectNode } from "@ttasks/client/test/nodes";
import type { SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api } from "../api.ts";
import { Session } from "../context.ts";
import { I18n } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import { FakeFrames } from "../../test/fake-frames.ts";
import { ProjectScreen } from "./ProjectScreen.tsx";
import { Sidebar } from "./Sidebar.tsx";

// The space switcher reads the machine's spaces, which this test has none of.
vi.mock("./SpaceSwitcher.tsx", () => ({ SpaceSwitcher: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const CURSOR = { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 };

// Client work › Lumen Health › Portal › Login page, and Internal beside Client work.
const WORK = "a_work";
const LUMEN = "n_lumen";
const PORTAL = "n_portal";
const LOGIN = "n_login";
const INTERNAL = "a_internal";
const nodes = nodesOf(
  SPACE.id,
  areaNode({ id: WORK, title: "Client work", position: "a" }, SPACE.id),
  areaNode({ id: INTERNAL, title: "Internal", position: "b" }, SPACE.id),
  projectNode(WORK, { id: LUMEN, title: "Lumen Health", position: "a" }),
  projectNode(LUMEN, { id: PORTAL, title: "Portal", position: "a" }),
  projectNode(PORTAL, { id: LOGIN, title: "Login page", position: "a" }),
);

let n = 0;
function task(title: string, parent: string, fields: Partial<TaskRow> = {}): TaskRow {
  n += 1;
  return {
    id: `t_${String(n).padStart(5, "0")}`,
    ref: `M-${String(n)}`,
    title,
    status: "open",
    inbox: false,
    lifecycle: "active",
    parent,
    position: `p${String(n).padStart(5, "0")}`,
    created_at: Date.UTC(2026, 10, 1),
    version: 1,
    ...fields,
  };
}

// Due days far ahead, so the line reads the same on any day the test runs.
const tasks = [
  task("Fix appointment time zones", LUMEN, { effort: "M", due_date: "2099-12-03" }),
  task("Store the clinic's zone ID", LUMEN, { effort: "S", status: "waiting" }),
  task("Monthly report", LUMEN),
  task("Portal plan", PORTAL, { effort: "XS" }),
  task("Login page copy", LOGIN, { due_date: "2099-12-09" }),
  task("Team offsite", INTERNAL),
];

const snapshot: SnapshotMessage = {
  type: "snapshot",
  space: SPACE,
  cursor: CURSOR,
  tasks,
  nodes,
  instances: [],
};

let container: HTMLDivElement;
let root: Root;
let live: Live;
let api: Api;

beforeEach(() => {
  localStorage.clear();
  const never = () => new Promise(() => undefined);
  api = {
    client: {
      task: { trash: never, get: never },
      page: { read: never },
    },
    projectFolder: never,
    busy: () => Promise.resolve({ busy: [], last: {} }),
    receipts: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
  } as unknown as Api;
  live = new Live({
    api,
    route: { space: SPACE.id },
    build: "",
    onSpace: () => undefined,
    onSignedOut: () => undefined,
    frames: new FakeFrames(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    live.store.push(snapshot);
    live.store.flush();
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  live.stop();
});

/** The side menu beside a project's screen, at `at`, as the page's routes lay them out. */
async function mount(at: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <I18n>
        <Session.Provider value={{ api, live }}>
          <Outlet />
        </Session.Provider>
      </I18n>
    ),
  });
  const screen = (tab: "tasks" | "library") =>
    function Screen({ project }: { readonly project: string }) {
      return (
        <>
          <nav aria-label="menu">
            <Sidebar space={SPACE.id} shelfOpen={false} onShelf={() => undefined} />
          </nav>
          <main>
            <ProjectScreen key={project} project={project} tab={tab} />
          </main>
        </>
      );
    };
  const Tasks = screen("tasks");
  const Library = screen("library");
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/s/$space/project/$project",
    component: function Route() {
      return <Tasks project={projectRoute.useParams().project} />;
    },
  });
  const libraryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/s/$space/project/$project/library",
    component: function Route() {
      return <Library project={libraryRoute.useParams().project} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute, libraryRoute]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  return router;
}

const at = (project: string, tab = "") => `/s/${SPACE.id}/project/${project}${tab}`;
const menu = () => container.querySelector<HTMLElement>('nav[aria-label="menu"]');
const main = () => container.querySelector<HTMLElement>("main");
/** The side menu's projects as a person meets them: each line's name, and its depth. */
const lines = () =>
  [...(menu()?.querySelectorAll<HTMLElement>("li[data-node]") ?? [])].map((li) => [
    li.querySelector("a")?.getAttribute("aria-label"),
    Number(li.dataset["depth"]),
  ]);
const foldOf = (name: string) =>
  menu()?.querySelector<HTMLButtonElement>(`button[aria-label$=" ${name}"][data-part="fold"]`);
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
};
const part = (name: string) => main()?.querySelector<HTMLElement>(`[data-part="${name}"]`);

describe("[S2.nav.screen] the side menu and a project's screen, four levels deep", () => {
  test("the menu nests every level with its count; the third level starts folded and the person's folds stay", async () => {
    await mount(at(INTERNAL));
    expect(lines()).toEqual([
      ["Client work, 5 tasks", 1],
      ["Lumen Health, 5 tasks", 2],
      ["Portal, 2 tasks", 3],
      ["Internal, 1 task", 1],
    ]);
    expect(foldOf("Portal")?.getAttribute("aria-expanded")).toBe("false");

    await click(foldOf("Portal"));
    expect(lines()).toContainEqual(["Login page, 1 task", 4]);

    // Folded, a project keeps its count.
    await click(foldOf("Client work"));
    expect(lines()).toEqual([
      ["Client work, 5 tasks", 1],
      ["Internal, 1 task", 1],
    ]);

    // Back after a reload as the person left them.
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await mount(at(INTERNAL));
    expect(lines()).toHaveLength(2);
    await click(foldOf("Client work"));
    expect(lines()).toContainEqual(["Login page, 1 task", 4]);
  });

  test("a folded project that holds the one on screen is the way back to it", async () => {
    await mount(at(LOGIN));
    await click(foldOf("Client work"));
    const work = menu()?.querySelector<HTMLElement>(`li[data-node="${WORK}"] a`);
    expect(work?.dataset["within"]).toBe("true");
  });

  test("a project's screen: its crumbs, its status line, its tabs, its own tasks, then each project below as a group that folds", async () => {
    const router = await mount(at(LUMEN));
    const crumbs = [...(part("crumbs")?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
    expect(crumbs).toEqual(["Client work", "Lumen Health"]);
    expect(part("project-status")?.textContent).toBe(
      "5 open · 1 waiting · about 5 h · 2 not sized · next due Thu 3 Dec 2099",
    );
    expect(part("node-tabs")?.textContent).toBe("Tasks5Library");

    const rows = () =>
      [...(main()?.querySelectorAll<HTMLElement>('[data-part="title"]') ?? [])].map(
        (title) => title.textContent,
      );
    expect(rows()).toEqual([
      "Fix appointment time zones",
      "Monthly report",
      "Store the clinic's zone ID",
      "Portal plan",
      "Login page copy",
    ]);
    const heading = main()?.querySelector<HTMLElement>('h2[data-kind="project"]');
    expect(heading?.querySelector("a")?.textContent).toBe("Portal");
    expect(heading?.querySelector('[data-part="group-status"]')?.textContent).toBe(
      "2 open · next due Wed 9 Dec 2099",
    );
    expect(main()?.querySelector("h3")?.textContent).toBe("Login page");

    await click(heading?.querySelector('[data-part="group-fold"]'));
    expect(rows()).toEqual([
      "Fix appointment time zones",
      "Monthly report",
      "Store the clinic's zone ID",
    ]);
    expect(main()?.querySelector('h2[data-kind="project"]')).not.toBeNull();

    // A crumb opens its project.
    await click(part("crumbs")?.querySelector("a"));
    expect(router.state.location.pathname).toBe(at(WORK));
    expect(part("project-status")?.textContent).toContain("5 open");
  });

  test("four levels deep: the crumbs name every level, and the narrow width keeps the last two after …", async () => {
    await mount(at(LOGIN));
    const items = [...(part("crumbs")?.querySelectorAll("li") ?? [])];
    expect(items.map((li) => li.textContent)).toEqual([
      "Client work",
      "Lumen Health",
      "…",
      "Portal",
      "Login page",
    ]);
    // What the narrow width hides: the levels above the last two; "…" shows only there.
    const far = items.filter((li) => li.className.includes("far"));
    expect(far.map((li) => li.textContent)).toEqual(["Client work", "Lumen Health"]);
    expect(items[2]?.getAttribute("aria-hidden")).toBe("true");
    expect(part("project-status")?.textContent).toBe(
      "1 open · 1 not sized · next due Wed 9 Dec 2099",
    );
  });

  test("the Library is a tab of the same screen, at the project's address", async () => {
    const router = await mount(at(PORTAL, "/library"));
    const [tasksTab, libraryTab] = [...(part("node-tabs")?.querySelectorAll("a") ?? [])];
    expect(libraryTab?.getAttribute("aria-current")).toBe("page");
    expect(tasksTab?.getAttribute("aria-current")).toBeNull();
    expect(main()?.querySelector('[data-part="library"]')).not.toBeNull();
    // A crumb opens the project above on the same tab.
    await click(part("crumbs")?.querySelectorAll("a")[1]);
    expect(router.state.location.pathname).toBe(at(LUMEN, "/library"));
  });
});
