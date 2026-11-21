import { describe, expect, test } from "vitest";
import {
  APP_NAME,
  CLI_NAME,
  ENV_PREFIX,
  MCP_SERVER_KEY,
  PRODUCT_ID,
  PRODUCT_NAME,
  PUBLISHER,
  envVar,
} from "./index.ts";

describe("[A7.3.2.brand.names] product names derive from one constant", () => {
  test("the identifier is a safe lowercase name; the product's name ends in the app's name", () => {
    expect(PRODUCT_ID).toMatch(/^[a-z][a-z0-9-]*$/);
    // TTasks, called TTasks inside the app, by TumbleToad (PLAN.md Q).
    expect(PRODUCT_NAME.endsWith(` ${APP_NAME}`)).toBe(true);
    expect(APP_NAME.toLowerCase()).toBe(PRODUCT_ID);
    expect(PUBLISHER).toMatch(/^\S+$/);
  });

  test("the CLI name and the MCP server key are plain identifiers", () => {
    expect(CLI_NAME).toBe(PRODUCT_ID);
    // MCP clients namespace tools as mcp__<key>__<tool>, so the key must be a plain identifier.
    expect(MCP_SERVER_KEY).toMatch(/^[a-z0-9_-]+$/);
  });

  test("environment variables carry the product prefix", () => {
    expect(ENV_PREFIX).toBe(`${PRODUCT_ID.toUpperCase().replaceAll("-", "_")}_`);
    expect(envVar("HOME")).toBe(`${ENV_PREFIX}HOME`);
    expect(() => envVar("lower")).toThrow();
  });
});
