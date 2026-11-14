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
//   /s/:space/search?q=                     search results (M5.10)
//   /s/:space/task/:id                      a task, expanded (its host view is M5.06's)
//   /s/:space/settings/:section             settings (M5.11; Appearance here)
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
import { SettingsPage, SETTINGS_SECTIONS } from "./Settings.tsx";
import { SpaceSession } from "./session.tsx";
import { Shell } from "./Shell.tsx";
import { isView, LANDING } from "./views.ts";

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <Navigate to="/" replace />,
});

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { task?: string } => {
    const task = search["task"];
    return typeof task === "string" && SEGMENT.test(task) ? { task } : {};
  },
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
  component: function ViewRoute() {
    const { space, view } = viewRoute.useParams();
    if (!isView(view)) {
      return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
    }
    return <ViewPage view={view} />;
  },
});

const areaRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area",
  component: function AreaRoute() {
    const { area } = areaRoute.useParams();
    return <AreaPage area={area} />;
  },
});

const projectRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area/project/$project",
  component: function ProjectRoute() {
    const { area, project } = projectRoute.useParams();
    return <AreaPage area={area} project={project} />;
  },
});

const searchRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "search",
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = search["q"];
    return typeof q === "string" && q.length <= 500 ? { q } : {};
  },
  component: SearchPage,
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
  path: "settings/$section",
  component: function SettingsRoute() {
    const { space, section } = settingsRoute.useParams();
    const known = SETTINGS_SECTIONS.find((s) => s === section);
    if (known === undefined) {
      return (
        <Navigate
          to="/s/$space/settings/$section"
          params={{ space, section: SETTINGS_SECTIONS[0] }}
          replace
        />
      );
    }
    return <SettingsPage section={known} />;
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
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
