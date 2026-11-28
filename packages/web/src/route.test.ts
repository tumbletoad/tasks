import { describe, expect, test } from "vitest";
import { NO_SUCH_SPACE, pagePath, readFragment } from "./route.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";
const CODE = "A".repeat(42) + "_";

describe("[A5.3.3.web.route] the tab's space comes from its route", () => {
  test("the page's paths, normalised", () => {
    expect(pagePath("/")).toBe("/");
    expect(pagePath("/index.html")).toBe("/");
    expect(pagePath(`/s/${SPACE}`)).toBe(`/s/${SPACE}`);
    expect(pagePath(`/s/${SPACE}/`)).toBe(`/s/${SPACE}`);
    expect(pagePath(`/s/${SPACE}/today`)).toBe(`/s/${SPACE}/today`);
    expect(pagePath(`/s/${SPACE}/area/ar_1/project/pj_2/library`)).toBe(
      `/s/${SPACE}/area/ar_1/project/pj_2/library`,
    );
    expect(pagePath(`/s/${SPACE}/task/M-14`)).toBe(`/s/${SPACE}/task/M-14`);
    // The skeleton's task links, and a task without a space (the default space's).
    expect(pagePath(`/s/${SPACE}/t/M-14`)).toBe(`/s/${SPACE}/task/M-14`);
    expect(pagePath("/task/M-14")).toBe("/?task=M-14");
  });

  test.each(["Mira", "Shared List", "Team.1", "Café", "a/b", "sp_X", SPACE.toUpperCase(), "%20"])(
    "a link with %s where the space goes reaches the page as a space it does not have",
    (space) => {
      expect(pagePath(`/s/${space}/task/M-14`)).toBe(NO_SUCH_SPACE);
      expect(pagePath(`/s/${encodeURIComponent(space)}`)).toBe(NO_SUCH_SPACE);
      expect(readFragment(`#to=${encodeURIComponent(`/s/${space}/task/M-14`)}`)).toEqual({
        to: NO_SUCH_SPACE,
      });
    },
  );

  test.each([
    "/s/",
    `/s/${SPACE}/area/ar_1/project/pj_2/library/more`,
    `/s/${SPACE}/task/<script>`,
    `/s/${SPACE}/task/a b`,
    "/settings",
    "/task/a/b",
    "//evil.example/",
    "https://evil.example/",
    "javascript:alert(1)",
  ])("%s is not a path of the page", (path) => {
    expect(pagePath(path)).toBeUndefined();
  });

  test("the fragment gives a code of the right shape and a page path, and nothing else", () => {
    expect(readFragment(`#k=${CODE}&to=${encodeURIComponent(`/s/${SPACE}/task/M-3`)}`)).toEqual({
      code: CODE,
      to: `/s/${SPACE}/task/M-3`,
    });
    expect(readFragment(`#k=short&to=https%3A%2F%2Fevil.example%2F`)).toEqual({});
    expect(readFragment("")).toEqual({});
    expect(readFragment(`#k=${CODE}&k=${CODE}x`)).toEqual({ code: CODE });
    expect(readFragment(`#${"k".repeat(600)}`)).toEqual({});
  });
});
