// The page's tags as a browser reads them (A2 3.8.3, 3.13): the one reader of the service's check
// of a built page and doctor's self-test. Every spelling a build may write gives the same value.
import { describe, expect, test } from "vitest";
import { metaContent, startTags } from "./tags.ts";

describe("[A2.3.8.http.tags] start tags read as a browser reads them", () => {
  test("a meta tag's content in any spelling a build writes", () => {
    const spellings = [
      '<meta name="csp-nonce" content="abc+/=">',
      '<meta name="csp-nonce" content="abc+/=" />',
      '<meta name="csp-nonce" content="abc+/="/>',
      '<meta content="abc+/=" name="csp-nonce">',
      "<meta name='csp-nonce' content='abc+/='>",
      "<META NAME=csp-nonce CONTENT=abc+/=>",
      '<meta\n  name = "csp-nonce"\n  content = "abc+/="\n/>',
      '<meta name="csp-nonce" content="abc&#43;/&#x3D;">',
    ];
    for (const html of spellings) {
      expect(metaContent(`<head>${html}</head>`, "csp-nonce"), html).toBe("abc+/=");
    }
  });

  test("the first tag and the first attribute of a name win, values compare exactly, comments are not read", () => {
    expect(metaContent('<meta name="csp-nonce" content="one" content="two">', "csp-nonce")).toBe(
      "one",
    );
    expect(
      metaContent(
        '<meta name="csp-nonce" content="a"><meta name="csp-nonce" content="b">',
        "csp-nonce",
      ),
    ).toBe("a");
    expect(metaContent('<meta name="CSP-NONCE" content="a">', "csp-nonce")).toBeUndefined();
    expect(
      metaContent(
        '<!-- <meta name="csp-nonce" content="x"> --><meta name="csp-nonce" content="y">',
        "csp-nonce",
      ),
    ).toBe("y");
    expect(metaContent('<meta name="csp-nonce">', "csp-nonce")).toBeUndefined();
    expect(metaContent("<p>no meta</p>", "csp-nonce")).toBeUndefined();
  });

  test("tag names, valueless attributes and an unterminated tag", () => {
    const tags = startTags(
      '<!doctype html><SCRIPT type=module SRC="/a.js" defer></script><link rel=stylesheet href=/b.css><p',
    );
    expect(tags.map((t) => t.name)).toEqual(["script", "link", "p"]);
    expect([...(tags[0]?.attributes ?? [])]).toEqual([
      ["type", "module"],
      ["src", "/a.js"],
      ["defer", ""],
    ]);
    expect(tags[1]?.attributes.get("href")).toBe("/b.css");
  });
});
