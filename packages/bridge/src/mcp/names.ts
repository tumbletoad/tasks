// The fixed names the bridge needs before it can reach the service, and its own build identity.
// The bridge imports only Node built-ins and its own package, so it cannot read the
// product names from packages/brand. These are part of the forwarder contract: a
// native forwarder hard-codes the same values. A test in packages/service checks each one against
// the product's names and the hub's layout, so a rename that misses this file fails verify.

/** The product's folder name: the data folder `~/.ttasks` and the program's folder. */
export const INSTALL_NAME = "ttasks";

/** The product's name in the bridge's own texts: packages/brand's PRODUCT_NAME. */
export const PRODUCT_NAME = "TTasks";

/** A separate install's root. */
export const HOME_VAR = "TTASKS_HOME";

/** The package identity the Windows launcher passes. */
export const PACKAGE_VAR = "TTASKS_PACKAGE";

/** `<state>/service.json` and `<state>/ipc.key`. */
export const SERVICE_FILE = "service.json";
export const KEY_FILE = "ipc.key";

/** The offline answers: `<cache>/mcp-offline.json` and `lib/mcp-offline.json`. */
export const OFFLINE_FILE = "mcp-offline.json";

/**
 * This build's version and build label, sent in the bind frame's `client` and compared with the
 * offline cache's `build`. The release build stamps its own, as it does for the service.
 */
export const BRIDGE_BUILD = { version: "0.0.0", build: "source" } as const;
