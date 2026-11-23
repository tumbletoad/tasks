// The tab's sessions (A5 3.3): one sign-in for the browser, and one live session per space the tab
// shows. The space is the route's: a switch mounts a new SpaceSession, which opens its own feed
// subscription with a fresh snapshot, and the old one stops and closes its socket. Nothing here
// is shared between tabs; another tab keeps its own space, feed and drafts.
//
// The seam to the live store (M5.02, A5 3.15) is narrow on purpose: the shell reads rows only
// through the store's `useLive()` (store/hooks.ts), and creates and stops a `Live` here, nowhere
// else. A stopped `Live` never comes back (its store takes no more messages), so every mount (a
// new sign-in, another space, a reload) creates a fresh one.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Api } from "../api.ts";
import { Session, type SessionValue } from "../context.ts";
import { Live } from "../live.ts";
import { changeLogOf } from "./changes.ts";
import { useMachine } from "./machine.ts";
import { forgetOpened, openedCopy } from "./opened.ts";

/** The browser's sign-in: its token, the build that served the page, and the way out. */
export interface Auth {
  readonly token: string;
  readonly build: string;
  /** The service refused the token: the page forgets it and shows the signed-out page. */
  readonly signedOut: () => void;
}

export const AuthContext = createContext<Auth | undefined>(undefined);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === undefined) throw new Error("useAuth outside the signed-in page");
  return auth;
}

/** Calls that name no space: the space list and Make default. */
export function useMachineApi(): Api {
  const { token, build } = useAuth();
  const [api] = useState(() => new Api(token, build, () => undefined));
  return api;
}

/** The live session of one space: its calls name it, its feed subscribes to it. */
export function SpaceSession({
  space,
  children,
}: {
  readonly space: string;
  readonly children: ReactNode;
}) {
  const auth = useAuth();
  const control = useMachine();
  // The feed outlives a render: it hands each message to the control the page holds now.
  const machine = useRef(control);
  machine.current = control;
  const [value, setValue] = useState<SessionValue | undefined>(undefined);
  useEffect(() => {
    // Every call names the copy of the space the feed loaded, once it did.
    const loaded: { live?: Live } = {};
    const api = new Api(
      auth.token,
      auth.build,
      () => space,
      () => loaded.live?.copy,
      () => loaded.live?.getState().gone !== undefined,
    );
    const live = new Live({
      api,
      route: { space },
      // The copy the person's Open folder answered, when they came here from it.
      copy: openedCopy(space),
      build: auth.build,
      onSpace: () => undefined,
      onSignedOut: auth.signedOut,
      onMachine: (preferences) => {
        machine.current.receive(preferences);
      },
    });
    loaded.live = live;
    // Today's Changes counts from the session's start, whichever view the tab opens on.
    changeLogOf(live);
    setValue({ api, live });
    // Once the tab loaded the space, or learned it cannot, the copy the person's Open folder
    // answered is no longer what the next load asks for.
    const stopWatching = live.subscribe(() => {
      const state = live.getState();
      if (state.phase !== "live" && state.gone === undefined) return;
      stopWatching();
      forgetOpened(space);
    });
    live.start();
    return () => {
      stopWatching();
      live.stop();
    };
  }, [auth, space]);
  if (value === undefined) return null;
  return <Session.Provider value={value}>{children}</Session.Provider>;
}
