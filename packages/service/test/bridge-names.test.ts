// The bridge imports only Node built-ins and its own package (A2 3.7.1), so it carries the few
// product names and folder rules it needs to find the service. This checks them against the
// product's names (packages/brand) and the hub's own layout, so a rename or a layout change that
// misses the bridge fails here.
import { envVar, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { AGENT_MARKERS, MCP_CONTEXT_ENV } from "@ttasks/bridge/protocol";
import {
  BRIDGE_BUILD,
  HOME_VAR,
  INSTALL_NAME,
  KEY_FILE,
  PACKAGE_VAR,
  PRODUCT_NAME as BRIDGE_PRODUCT_NAME,
  SERVICE_FILE,
  installFolders,
} from "@ttasks/bridge/mcp";
import { describe, expect, test } from "vitest";
import { TTASKS_PACKAGE } from "../src/hub/identity.ts";
import { KEY_FILE as HUB_KEY_FILE } from "../src/hub/key.ts";
import { TTASKS_HOME, resolveLayout, type HostFacts } from "../src/hub/paths.ts";
import { BUILD, SERVICE_FILE as HUB_SERVICE_FILE } from "../src/hub/service.ts";

const cases: HostFacts[] = [
  { platform: "linux", env: { HOME: "/snap/firefox/1" }, accountHome: "/home/mira", uid: 1000 },
  { platform: "linux", env: { HOME: "/home/mira" }, accountHome: undefined, uid: 1000 },
  {
    platform: "linux",
    env: { TTASKS_HOME: "/tmp/ttasks-test" },
    accountHome: "/home/mira",
    uid: 1000,
  },
  { platform: "darwin", env: {}, accountHome: "/Users/mira", uid: 501 },
  {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\mira" },
    accountHome: "C:\\Users\\other",
    uid: undefined,
  },
  { platform: "win32", env: {}, accountHome: "C:\\Users\\mira", uid: undefined },
  {
    platform: "win32",
    env: { TTASKS_HOME: "D:\\ttasks-test\\" },
    accountHome: undefined,
    uid: undefined,
  },
];

describe("[A2.3.7.bridge.discovery] the bridge's names and folders are the product's", () => {
  test("names: the product, the install folder, the environment names, the state files and the build", () => {
    expect(INSTALL_NAME).toBe(PRODUCT_ID);
    expect(BRIDGE_PRODUCT_NAME).toBe(PRODUCT_NAME);
    expect(HOME_VAR).toBe(envVar("HOME"));
    expect(HOME_VAR).toBe(TTASKS_HOME);
    expect(PACKAGE_VAR).toBe(TTASKS_PACKAGE);
    expect(SERVICE_FILE).toBe(HUB_SERVICE_FILE);
    expect(KEY_FILE).toBe(HUB_KEY_FILE);
    expect(BRIDGE_BUILD).toEqual(BUILD);
    // Every name the bridge copies is one of A3's markers or TTASKS_SPACE, under the product prefix.
    for (const name of MCP_CONTEXT_ENV) {
      expect([...AGENT_MARKERS, envVar("SPACE")]).toContain(name);
    }
  });

  test.each(cases)("the state and cache folders equal the hub's layout (%o)", (facts) => {
    const layout = resolveLayout(facts);
    expect(installFolders(facts)).toEqual({ state: layout.state, cache: layout.cache });
  });

  test("a layout the hub refuses, the bridge refuses too", () => {
    for (const facts of [
      { platform: "linux", env: { TTASKS_HOME: "relative" }, accountHome: "/home/mira", uid: 1 },
      { platform: "linux", env: {}, accountHome: undefined, uid: 1 },
    ] satisfies HostFacts[]) {
      expect(() => resolveLayout(facts)).toThrow();
      expect(() => installFolders(facts)).toThrow();
    }
  });
});
