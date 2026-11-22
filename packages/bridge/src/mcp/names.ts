// The fixed names the bridge needs before it can reach the service, and its own build identity.
// The bridge imports only Node built-ins and its own package (A2 3.7.1), so it cannot read the
// product names from packages/brand. These are part of the forwarder contract (A2 3.7.6): a
// native forwarder hard-codes the same values. A test in packages/service checks each one against
// the product's names and the hub's layout, so a rename that misses this file fails verify.

/** The product's folder name (A2 3.2.1): the data folder `~/.ttasks` and the program's folder. */
export const INSTALL_NAME = "ttasks";

/** The product's name in the bridge's own texts: packages/brand's PRODUCT_NAME. */
export const PRODUCT_NAME = "TTasks";

/** A separate install's root (A2 3.2.2 rule 3, D18). */
export const HOME_VAR = "TTASKS_HOME";

/** The package identity the Windows launcher passes (A2 3.5). */
export const PACKAGE_VAR = "TTASKS_PACKAGE";

/** `<state>/service.json` and `<state>/ipc.key` (A2 3.2.3). */
export const SERVICE_FILE = "service.json";
export const KEY_FILE = "ipc.key";

/** The offline answers: `<cache>/mcp-offline.json` and `lib/mcp-offline.json` (A2 3.7.3). */
export const OFFLINE_FILE = "mcp-offline.json";

/**
 * This build's version and build label, sent in the bind frame's `client` and compared with the
 * offline cache's `build`. M1.13's release build stamps its own, as it does for the service.
 */
export const BRIDGE_BUILD = { version: "0.0.0", build: "source" } as const;
