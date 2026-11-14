// The tab's session for its components: the calls (with the token and the tab's space) and the
// live view of its space.
import { createContext } from "react";
import type { Api } from "./api.ts";
import type { Live } from "./live.ts";

export interface SessionValue {
  readonly api: Api;
  readonly live: Live;
}

export const Session = createContext<SessionValue>(undefined as unknown as SessionValue);
