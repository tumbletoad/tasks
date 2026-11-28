// The product's names, in one place. Every name that people, agents or the operating system see
// derives from these constants, so a rename touches this file. Package names (`@ttasks/*`) live
// in package.json files.

/**
 * The product's name, inside the app and out: the page, messages of the CLI and the service, the
 * Run value and service entries, `ttasks version`, briefs and the MCP server's instructions.
 */
export const PRODUCT_NAME = "TTasks";

/** The publisher, shown as "by TumbleToad" beside the product's name. */
export const PUBLISHER = "TumbleToad";

/**
 * The lowercase identifier: the CLI command, the environment prefix, the install and data folder
 * names, the service unit, label and pipe names.
 */
export const PRODUCT_ID = "ttasks";

/** The CLI command. */
export const CLI_NAME = PRODUCT_ID;

/** The MCP server key in every agent configuration. Clients namespace tools with it. */
export const MCP_SERVER_KEY = "ttasks";

/**
 * The folder in the user's home that holds the person's data and configuration: `~/.ttasks/`
 * (`%USERPROFILE%\.ttasks\`), with `config/`, `state/`, `cache/` and `spaces/`.
 */
export const DATA_FOLDER = `.${PRODUCT_ID}`;

/**
 * The marker TTasks leaves in a project's or a task's folder, naming whose folder it is:
 * `.ttasks-marker/`. Not the data folder's name, which a project whose folder is the home would meet.
 */
export const FOLDER_MARKER = `.${PRODUCT_ID}-marker`;

/** The folder of the data folder (or of TTASKS_HOME) that holds spaces by default: `spaces/<slug>/`. */
export const SPACES_FOLDER = "spaces";

/**
 * The Agent Monitor, a separate program by the same publisher that the Agents page reads: its name
 * in text, and the command TTasks finds on the PATH.
 */
export const MONITOR_NAME = "TTAM";
export const MONITOR_COMMAND = "ttam";

/**
 * The folder of the data folder (or of TTASKS_HOME) that holds the person's skills,
 * `skills/<name>/SKILL.md`: the layout of the repository's own `skills/`.
 */
export const SKILLS_FOLDER = "skills";

/** The prefix of every environment variable the product reads or sets. */
export const ENV_PREFIX = "TTASKS_";

/** The name of one of the product's environment variables, for example `envVar("HOME")`. */
export function envVar<const N extends string>(name: N): `${typeof ENV_PREFIX}${N}` {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid environment variable suffix`);
  return `${ENV_PREFIX}${name}`;
}

/**
 * The name of one of the product's HTTP headers, for example `httpHeader("build")`: `ttasks-build`.
 * Header names derive from the identifier, never from the display name, which may hold a space
 * or a capital: fetch refuses a header name with a space.
 */
export function httpHeader<const N extends string>(name: N): `${typeof PRODUCT_ID}-${N}` {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid header name suffix`);
  return `${PRODUCT_ID}-${name}`;
}
