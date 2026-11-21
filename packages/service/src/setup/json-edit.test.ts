// The JSON splice for an app setup writes itself (A3 3.13.3, M4.05): one member in, the same member
// out, and every other byte as it was, in each layout a person or an app writes.
import { describe, expect, test } from "vitest";
import { addEntry, removeEntry } from "./json-edit.ts";

const ENTRY = {
  command: "/opt/ttasks/bin/ttasks",
  args: ["mcp", "--space", "sp_x", "--app", "a b"],
};

/** Adds the entry, checks the document, then removes it and expects the original bytes back. */
function roundTrip(text: string, created: boolean): string {
  const added = addEntry(text, "mcpServers", "ttasks", ENTRY);
  if (!added.ok) throw new Error(`refused: ${added.reason}`);
  const doc = JSON.parse(added.text) as { mcpServers: Record<string, unknown> };
  expect(doc.mcpServers["ttasks"]).toEqual(ENTRY);
  const removed = removeEntry(added.text, "mcpServers", "ttasks", created);
  if (!removed.ok) throw new Error(`refused: ${removed.reason}`);
  expect(removed.text).toBe(text);
  return added.text;
}

describe("[A3.3.13.setup.json-edit] one entry spliced in and out of a JSON file, every other byte kept", () => {
  test("multi-line files: two spaces, four spaces, tabs and CRLF, with and without other servers", () => {
    const twoSpaces =
      '{\n  "numStartups": 3,\n  "mcpServers": {\n    "other": {\n      "command": "x"\n    }\n  }\n}\n';
    const added = roundTrip(twoSpaces, false);
    expect(added).toContain(
      '    },\n    "ttasks": {\n      "command": "/opt/ttasks/bin/ttasks",\n',
    );
    roundTrip(twoSpaces.replaceAll("  ", "    "), false);
    roundTrip(twoSpaces.replaceAll("  ", "\t"), false);
    const crlf = twoSpaces.replaceAll("\n", "\r\n");
    const crlfAdded = roundTrip(crlf, false);
    expect(crlfAdded.replaceAll("\r\n", "")).not.toContain("\n");
    // Another top-level member after the servers, and servers written inline in a multi-line file.
    roundTrip('{\n  "mcpServers": {"other": {"command": "x"}},\n  "theme": "dark"\n}', false);
  });

  test("an empty servers table and a file without one: setup's own table goes again with its entry", () => {
    roundTrip('{\n  "mcpServers": {}\n}\n', false);
    roundTrip('{\n  "preferences": {\n    "a": 1\n  }\n}\n', true);
    roundTrip("{}", true);
    roundTrip("{}\n", true);
    roundTrip('{"preferences":{"a":1}}', true);
    // Kept when told to: a table the person made stays, empty.
    const added = addEntry('{"mcpServers": {}}', "mcpServers", "ttasks", ENTRY);
    expect(added.ok && removeEntry(added.text, "mcpServers", "ttasks", false)).toEqual({
      ok: true,
      text: '{"mcpServers": {}}',
    });
  });

  test("the entry first among others comes out with its comma; strings with brackets are no structure", () => {
    const text =
      '{\n  "mcpServers": {\n    "ttasks": {"command": "y"},\n    "x}{": {"command": "]["}\n  }\n}\n';
    const removed = removeEntry(text, "mcpServers", "ttasks", false);
    expect(removed).toEqual({
      ok: true,
      text: '{\n  "mcpServers": {\n    "x}{": {"command": "]["}\n  }\n}\n',
    });
  });

  test("refused: not JSON, servers that are not an object, an entry already there, a key that is not there", () => {
    expect(addEntry("{ not json", "mcpServers", "ttasks", ENTRY)).toEqual({
      ok: false,
      reason: "invalid_file",
    });
    expect(addEntry('{"mcpServers": []}', "mcpServers", "ttasks", ENTRY)).toMatchObject({
      ok: false,
    });
    expect(addEntry('{"mcpServers": {"ttasks": {}}}', "mcpServers", "ttasks", ENTRY)).toMatchObject(
      {
        ok: false,
      },
    );
    expect(removeEntry('{"mcpServers": {}}', "mcpServers", "ttasks", true)).toMatchObject({
      ok: false,
    });
    expect(addEntry("[1, 2]", "mcpServers", "ttasks", ENTRY)).toEqual({
      ok: false,
      reason: "invalid_file",
    });
  });
});
