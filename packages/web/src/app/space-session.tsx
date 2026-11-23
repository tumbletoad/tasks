// A tab's live session of the space it shows (A5 3.3): the space is the route's, and a switch
// mounts a new SpaceSession, which opens its own feed subscription with a fresh snapshot, and the
// old one stops and closes its socket. Nothing here is shared between tabs; another tab keeps its
// own space, feed and drafts.
//
// A session shows one copy of its space for its whole life (route.ts): the copy its route's key
// names, or for a route that names the space's ID, the copy that ID means as the tab arrives. Its
// calls, its feed and the text it keeps name that copy's key, so nothing it does reaches another
// copy of the space, whatever happens to the copies meanwhile.
//
// The seam to the live store (M5.02, A5 3.15) is narrow on purpose: the shell reads rows only
// through the store's `useLive()` (store/hooks.ts), and creates and stops a `Live` here, nowhere
// else. A stopped `Live` never comes back (its store takes no more messages), so every mount (a
// new sign-in, another space, a reload) creates a fresh one.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Api, SignedOut } from "../api.ts";
import { Session, type SessionValue } from "../context.ts";
import { useT } from "../i18n/intl.tsx";
import { Live } from "../live.ts";
import { COPY_KEY } from "../route.ts";
import { changeLogOf } from "./changes.ts";
import { classes } from "./css.ts";
import { Landing } from "./Landing.tsx";
import landing from "./Landing.module.css";
import { forgetGone } from "./leftovers.ts";
import { useMachine } from "./machine.ts";
import { useAuth, useMachineApi } from "./session.tsx";
import { copyAt, listSpaces } from "./spaces.ts";

const styles = classes(landing, ["line"]);

/** Where a tab arrives: one copy, no copy now, or a list that could not be read. */
type Arrival = { readonly copy: string } | "none" | "failed";

/**
 * The copy a tab on `address` shows, by its key: the address itself when it is a key, else the
 * copy the space's ID means now, by the space list; `none` when it means none now.
 */
function useArrival(address: string): Arrival | undefined {
  const auth = useAuth();
  const api = useMachineApi();
  const named = COPY_KEY.test(address);
  const [found, setFound] = useState<Arrival | undefined>(undefined);
  useEffect(() => {
    if (named) return;
    let current = true;
    listSpaces(api).then(
      (list) => {
        const copy = copyAt(list, address);
        if (current) setFound(copy === undefined ? "none" : { copy });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) auth.signedOut();
        else if (current) setFound("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [api, auth, address, named]);
  return named ? { copy: address } : found;
}

/** The live session of the copy a tab shows: its calls name it, its feed subscribes to it. */
export function SpaceSession({
  space,
  children,
}: {
  /** The route's space: the space's ID, or one copy's key. */
  readonly space: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  const arrival = useArrival(space);
  if (arrival === undefined) return null;
  if (arrival === "failed") return <p className={styles.line}>{t("space.listFailed")}</p>;
  // The ID means no copy now: the person chooses one, and nothing is chosen for them.
  if (arrival === "none") return <Landing missing />;
  return (
    <CopySession key={arrival.copy} space={space} copy={arrival.copy}>
      {children}
    </CopySession>
  );
}

function CopySession({
  space,
  copy,
  children,
}: {
  readonly space: string;
  readonly copy: string;
  readonly children: ReactNode;
}) {
  const auth = useAuth();
  const control = useMachine();
  // The feed outlives a render: it hands each message to the control the page holds now.
  const machine = useRef(control);
  machine.current = control;
  const [value, setValue] = useState<SessionValue | undefined>(undefined);
  useEffect(() => {
    const api = new Api(auth.token, auth.build, () => copy);
    const live = new Live({
      api,
      route: { space, copy },
      build: auth.build,
      onSpace: () => undefined,
      onSignedOut: auth.signedOut,
      onMachine: (preferences) => {
        machine.current.receive(preferences);
      },
    });
    // Today's Changes counts from the session's start, whichever view the tab opens on.
    changeLogOf(live);
    setValue({ api, live });
    // Once the copy is live, the kept text of its tasks that are gone for good is forgotten.
    const stopWatching = live.subscribe(() => {
      if (live.getState().phase !== "live") return;
      stopWatching();
      void forgetGone(copy, api, (task) => live.getState().tasks.has(task));
    });
    live.start();
    return () => {
      stopWatching();
      live.stop();
    };
  }, [auth, space, copy]);
  if (value === undefined) return null;
  return <Session.Provider value={value}>{children}</Session.Provider>;
}
