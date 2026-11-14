// The product's names, in one place (PLAN.md Q). Every name that users, agents or the
// operating system see derives from these constants, so a rename touches this file (A2 3.2.1,
// A3 3.2.4, A7 3.2). Package names (`@tasks/*`) live in package.json files.

/**
 * The product's name, what people read outside the app and what agents are told: messages of the
 * CLI and the service, the Run value and service entries, `tasks version`, briefs ("Every Brief
 * contains the product's name", A3) and the MCP server's instructions.
 */
export const PRODUCT_NAME = "TT Tasks";

/** The name inside the app: the UI's title and its own words. */
export const APP_NAME = "Tasks";

/** The publisher, shown as "by TumbleToad" beside the product's name. */
export const PUBLISHER = "TumbleToad";

/**
 * The lowercase identifier: the CLI command, the environment prefix, the install and data folder
 * names, the service unit, label and pipe names.
 */
export const PRODUCT_ID = "tasks";

/** The CLI command (A2 3.10). */
export const CLI_NAME = PRODUCT_ID;

/**
 * The MCP server key in every agent configuration (A3 3.2.4). Clients namespace tools with it. Its
 * own value, so it alone can change (to `tt-tasks`) if `tasks` confuses agents (A3 3.2.4).
 */
export const MCP_SERVER_KEY = "tasks";

/**
 * The folder in the user's home that holds the person's data and configuration: `~/.tasks/`
 * (`%USERPROFILE%\.tasks\`), with `config/`, `state/`, `cache/` and `spaces/` (A2 3.2.1).
 */
export const DATA_FOLDER = `.${PRODUCT_ID}`;

/** The folder of the data folder (or of TASKS_HOME) that holds spaces by default: `spaces/<slug>/`. */
export const SPACES_FOLDER = "spaces";

/** The prefix of every environment variable the product reads or sets. */
export const ENV_PREFIX = "TASKS_";

/** The name of one of the product's environment variables, for example `envVar("HOME")`. */
export function envVar<const N extends string>(name: N): `${typeof ENV_PREFIX}${N}` {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid environment variable suffix`);
  return `${ENV_PREFIX}${name}`;
}

/**
 * The name of one of the product's HTTP headers, for example `httpHeader("build")`: `tasks-build`.
 * Header names derive from the identifier, never from a display name: "TT Tasks" holds a space,
 * which no header name may, and fetch refuses a request that carries one.
 */
export function httpHeader<const N extends string>(name: N): `${typeof PRODUCT_ID}-${N}` {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid header name suffix`);
  return `${PRODUCT_ID}-${name}`;
}
