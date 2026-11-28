// The page contract both lanes build against before its entries join the registry: the entries
// pass every registry rule beside the entries already there, and the examples that no entry holds
// match the shapes the feed and the errors carry.
import { describe, expect, test } from "vitest";
import { checkRegistry } from "./check.ts";
import {
  PAGE_CONFLICT_EXAMPLE,
  PAGE_ENTRIES,
  PAGE_FEED_EXAMPLES,
} from "./entries/page-examples.ts";
import { isErrorCode } from "./errors.ts";
import { opSpec } from "./operations.ts";
import { CompactPage, FinishLibrary, NOTHING_REUSABLE, PageAgentChange } from "./pages.ts";
import { registry } from "./registry.ts";

describe("[A3.pages.contract] the page contract of step 1", () => {
  test("the page entries pass the registry check beside the registry", () => {
    expect(checkRegistry([...registry, ...PAGE_ENTRIES])).toEqual([]);
  });

  test("the text for agents is the person's alone", () => {
    expect(opSpec("node.instruct")?.class).toBe("user");
    expect(opSpec("page.edit")?.class).toBe("agent");
  });

  test("the feed's page rows, and a page leaving the live lists, match the page row", () => {
    for (const row of PAGE_FEED_EXAMPLES.snapshotPages) {
      expect(CompactPage.safeParse(row).success).toBe(true);
    }
    const [leaving] = PAGE_FEED_EXAMPLES.pageLeaves.entities;
    const row = CompactPage.parse(leaving?.row);
    expect(row.deleted_at).toBeDefined();
    expect(PageAgentChange.safeParse(PAGE_FEED_EXAMPLES.agentChange).success).toBe(true);
  });

  test("a Restore that meets a newer body is a conflict that names the page's body", () => {
    expect(isErrorCode(PAGE_CONFLICT_EXAMPLE.code)).toBe(true);
    expect(PAGE_CONFLICT_EXAMPLE.data?.["conflicts"]).toEqual([
      expect.objectContaining({ entity: "pages", field: "body" }),
    ]);
  });

  test("a finish names the pages it updated, or that there were none", () => {
    expect(FinishLibrary.safeParse(["M-180"]).success).toBe(true);
    expect(FinishLibrary.safeParse(NOTHING_REUSABLE).success).toBe(true);
    expect(FinishLibrary.safeParse([]).success).toBe(false);
  });
});
