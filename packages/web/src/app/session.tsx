// The browser's sign-in (A5 3.3): one for every tab of the browser. Each space a tab shows has a
// live session of its own (space-session.tsx).
import { createContext, useContext, useState } from "react";
import { Api } from "../api.ts";

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
