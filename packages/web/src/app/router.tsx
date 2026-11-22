// The page's routes (A5 3.3, U17): every screen has a URL, so reload, Back and Forward work and
// agents can print links. Each tab holds its space in its route (`/s/:space/…`, U24): the space
// layout keys its live session by the route's space, so switching space in one tab never touches
// another tab, and `/` opens the machine's default space (Landing).
//
//   /                                       the default space's landing view (`?task=` a task)
//   /s/:space                               the space's landing view (Today)
//   /s/:space/:view                         today, inbox, open, waiting, review, backlog,
//                                           completed, agents
//   /s/:space/area/:area                    an area
//   /s/:space/area/:area/project/:project   a project of it
//   /s/:space/search?q=                     search results of the top field (`?task=` too)
//   /s/:space/task/:id                      a task link: resolved to its host view (host.ts)
//   /s/:space/settings                    Settings (an older `settings/:section` link lands there)
//
// A view, an area or a project with `?task=<ref>` holds that task expanded (A5 3.3): expanding a
// row writes it there, so a reload, Back and Forward keep the expansion, and the link stays a
// link to the task.
//
// A path of another shape lands on `/`. Route parameters come from the URL, so each is checked by
// its shape before it is used.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { SPACE_ID, SEGMENT } from "../route.ts";
import { Landing } from "./Landing.tsx";
import { AreaPage, SearchPage, TaskPage, ViewPage } from "./pages.tsx";
import { SettingsPage } from "./Settings.tsx";
import { SpaceSession } from "./session.tsx";
import { Shell } from "./Shell.tsx";
import { isView, LANDING } from "./views.ts";

/** A view's search: the task it holds expanded, a reference or an ID, checked by its shape. */
export function taskSearch(search: Record<string, unknown>): { task?: string } {
  const task = search["task"];
  return typeof task === "string" && SEGMENT.test(task) ? { task } : {};
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <Navigate to="/" replace />,
});

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: taskSearch,
  component: function LandingRoute() {
    const { task } = landingRoute.useSearch();
    return <Landing {...(task === undefined ? {} : { task })} />;
  },
});

export const spaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space",
  component: function SpaceLayout() {
    const { space } = spaceRoute.useParams();
    if (!SPACE_ID.test(space)) return <Navigate to="/" replace />;
    return (
      <SpaceSession key={space} space={space}>
        <Shell space={space} />
      </SpaceSession>
    );
  },
});

const spaceIndexRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "/",
  component: function SpaceIndex() {
    const { space } = spaceRoute.useParams();
    return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
  },
});

const viewRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "$view",
  validateSearch: taskSearch,
  component: function ViewRoute() {
    const { space, view } = viewRoute.useParams();
    const { task } = viewRoute.useSearch();
    if (!isView(view)) {
      return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
    }
    return <ViewPage view={view} task={task} />;
  },
});

const areaRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area",
  validateSearch: taskSearch,
  component: function AreaRoute() {
    const { area } = areaRoute.useParams();
    const { task } = areaRoute.useSearch();
    return <AreaPage area={area} task={task} />;
  },
});

const projectRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area/project/$project",
  validateSearch: taskSearch,
  component: function ProjectRoute() {
    const { area, project } = projectRoute.useParams();
    const { task } = projectRoute.useSearch();
    return <AreaPage area={area} project={project} task={task} />;
  },
});

/** The search's text (at most what the field takes) and its expanded result. */
export function searchSearch(search: Record<string, unknown>): { q?: string; task?: string } {
  const q = search["q"];
  return { ...(typeof q === "string" && q.length <= 500 ? { q } : {}), ...taskSearch(search) };
}

const searchRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "search",
  validateSearch: searchSearch,
  component: function SearchRoute() {
    const { q, task } = searchRoute.useSearch();
    return <SearchPage q={q} task={task} />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "task/$task",
  component: function TaskRoute() {
    const { task } = taskRoute.useParams();
    return <TaskPage task={task} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "settings",
  component: SettingsPage,
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "settings/$section",
  component: function SettingsSection() {
    const { space } = settingsSectionRoute.useParams();
    return <Navigate to="/s/$space/settings" params={{ space }} replace />;
  },
});

const routeTree = rootRoute.addChildren([
  landingRoute,
  spaceRoute.addChildren([
    spaceIndexRoute,
    viewRoute,
    areaRoute,
    projectRoute,
    searchRoute,
    taskRoute,
    settingsRoute,
    settingsSectionRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
