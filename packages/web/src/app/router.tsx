// The page's routes (A5 3.3, U17): every screen has a URL, so reload, Back and Forward work and
// agents can print links. Each tab holds its space in its route (`/s/:space/…`, U24): the space
// layout keys its live session by the route's space, so switching space in one tab never touches
// another tab, and `/` opens the machine's default space (Landing).
//
//   /                                       the default space's landing view (`?task=` a task)
//   /s/:space                               the space's landing view (Today)
//   /s/:space/:view                         today, inbox, open, waiting, review, backlog,
//                                           completed, agents, activity, library (the space's),
//                                           trash
//   /s/:space/area/:area                    an area; `/library` after it, its Library
//   /s/:space/area/:area/project/:project   a project of it; `/library` after it, its Library
//   /s/:space/project/:project              a project without an area; `/library` likewise
//   /s/:space/page/:ref                     a page of the library; where the person came from is
//                                           in the history entry (`from`), never the address
//   /s/:space/search                        search results of the top field (`?task=` too); the
//                                           query is in the history entry (route.ts)
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
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { searchQueryOf, SPACE_ID, SEGMENT } from "../route.ts";
import { Landing } from "./Landing.tsx";
import { PageScreen } from "../library/PageScreen.tsx";
import { AreaPage, ProjectPage, SearchPage, TaskPage, ViewPage } from "./pages.tsx";
import { SettingsPage } from "./Settings.tsx";
import { SpaceSession } from "./session.tsx";
import { Shell } from "./Shell.tsx";
import { isView, LANDING } from "@ttasks/client/today";

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
    // A link to a space the page cannot have says so and lets the person choose: landing on the
    // default would put their next edit in another list without a word.
    if (!SPACE_ID.test(space)) return <Landing unknown />;
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
    const { space, area, project } = projectRoute.useParams();
    const { task } = projectRoute.useSearch();
    return <ProjectPage space={space} area={area} project={project} task={task} />;
  },
});

const areaLibraryRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area/library",
  component: function AreaLibraryRoute() {
    const { area } = areaLibraryRoute.useParams();
    return <AreaPage area={area} tab="library" />;
  },
});

const projectLibraryRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "area/$area/project/$project/library",
  component: function ProjectLibraryRoute() {
    const { space, area, project } = projectLibraryRoute.useParams();
    return <ProjectPage space={space} area={area} project={project} tab="library" />;
  },
});

const looseProjectLibraryRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "project/$project/library",
  component: function LooseProjectLibraryRoute() {
    const { space, project } = looseProjectLibraryRoute.useParams();
    return <ProjectPage space={space} project={project} tab="library" />;
  },
});

const pageRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "page/$ref",
  component: function PageRoute() {
    const { space, ref } = pageRoute.useParams();
    if (!SEGMENT.test(ref)) {
      return <Navigate to="/s/$space/$view" params={{ space, view: LANDING }} replace />;
    }
    // Keyed by the page: another page starts with nothing open.
    return <PageScreen key={ref} page={ref} />;
  },
});

const looseProjectRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "project/$project",
  validateSearch: taskSearch,
  component: function LooseProjectRoute() {
    const { space, project } = looseProjectRoute.useParams();
    const { task } = looseProjectRoute.useSearch();
    return <ProjectPage space={space} project={project} task={task} />;
  },
});

/** A link's search text (at most what the field takes) and its expanded result. */
export function searchSearch(search: Record<string, unknown>): { q?: string; task?: string } {
  const q = search["q"];
  return { ...(typeof q === "string" && q.length <= 500 ? { q } : {}), ...taskSearch(search) };
}

const searchRoute = createRoute({
  getParentRoute: () => spaceRoute,
  path: "search",
  validateSearch: searchSearch,
  component: function SearchRoute() {
    const { q: linked, task } = searchRoute.useSearch();
    const q = useRouterState({ select: (s) => searchQueryOf(s.location) });
    const navigate = searchRoute.useNavigate();
    // A link's words (an older bookmark, Today's numbers) move into the tab's entry on arrival, so
    // the address that is copied or kept in the history from here holds none of them.
    useEffect(() => {
      if (linked === undefined) return;
      void navigate({
        search: task === undefined ? {} : { task },
        state: (kept) => ({ ...kept, q }),
        replace: true,
      });
    }, [linked, task, q, navigate]);
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
    looseProjectRoute,
    areaLibraryRoute,
    projectLibraryRoute,
    looseProjectLibraryRoute,
    pageRoute,
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
  // The search route's history entry holds its query (route.ts); a page's, where the person came
  // from: the address to go back to and its name.
  interface HistoryState {
    q?: string;
    from?: { readonly path: string; readonly label: string };
    /** A page the person just made: its body's pen is open. */
    pen?: "body";
  }
}
