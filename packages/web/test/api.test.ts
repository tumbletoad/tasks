// The page's API calls (A2 3.8.3, 3.8.4): each carries the build the page was served with and the
// tab's space, in the header names the service reads. The names derive from the identifier: a
// display name with a space is no header name, and fetch refuses the whole request (the rename to
// "TTasks" did that once). Node's Headers checks names as a browser's does.
import { afterEach, describe, expect, test, vi } from "vitest";
import { BUILD_HEADER, SPACE_HEADER } from "@ttasks/service/http";
import { Api } from "../src/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[A2.3.8.3.page.headers] the page's API calls", () => {
  test("send the page's build and the tab's space in the service's own header names", async () => {
    const sent: Headers[] = [];
    vi.stubGlobal("fetch", (_path: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const api = new Api("fixture-token", "fixture-build", () => "sp_fixture");
    await api.post("/api/v1/op/space.status", "{}");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.get(BUILD_HEADER)).toBe("fixture-build");
    expect(sent[0]?.get(SPACE_HEADER)).toBe("sp_fixture");
  });
});
