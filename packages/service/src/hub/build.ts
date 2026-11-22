// This build's identity, apart from the hub's lifecycle so the MCP endpoint and the offline file
// can name it without loading the service.
import { SOURCE_APP_VERSION } from "@ttasks/storage";

/** This build's version and build label. M1.13's release build stamps its own. */
export const BUILD = { version: SOURCE_APP_VERSION, build: "source" } as const;
