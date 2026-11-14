// The "restored exactly" cases of row L10 (M0.10): realistic configuration files for Claude Code's
// `.claude.json` and Codex's `config.toml`, as functions of the folder key under test. The
// self-test runs them on fixture files with no CLI; the lab command runs the same files in scratch
// homes with the real CLIs. Fixture text only: no real path, account or setting.

export interface Case {
  name: string;
  /** What the case shows. */
  about: string;
  /** The file before the patch, or null when it does not exist. */
  text: string | null;
  /** The change the patch is expected to make. */
  expect: "file" | "container" | "entry" | "field" | "value" | "none" | "refused";
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Claude Code `.claude.json` cases for project key `key`; `other` is another folder's key. */
export function claudeCases(key: string, other: string): Case[] {
  const base = {
    numStartups: 12,
    installMethod: "native",
    autoUpdates: false,
    tipsHistory: { "new-user-warmup": 3, "plan-mode": 1 },
    mcpServers: {
      "fixture-server": { type: "stdio", command: "node", args: ["server.js"], env: {} },
    },
  };
  const otherEntry = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 2,
    lastCost: 0.12,
  };
  const ownEntry = { allowedTools: [], mcpServers: {}, projectOnboardingSeenCount: 0 };
  const crlfTabs = `{\r\n\t"numStartups" : 3,\r\n\r\n\t"projects" : {\r\n\t\t${JSON.stringify(other)} : {\r\n\t\t\t"hasTrustDialogAccepted" : true\r\n\t\t}\r\n\t},\r\n\t"theme" : "dark"\r\n}\r\n`;
  const escapedKey = JSON.stringify(key).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return [
    { name: "no-file", about: "the file did not exist", text: null, expect: "file" },
    {
      name: "no-projects",
      about: "other content, no projects member",
      text: json(base),
      expect: "container",
    },
    {
      name: "other-projects",
      about: "projects with other folders' entries",
      text: json({
        ...base,
        projects: { [other]: otherEntry, [`${other}-2`]: { ...otherEntry, lastCost: 0 } },
      }),
      expect: "entry",
    },
    {
      name: "empty-projects",
      about: "an empty projects object written over two lines",
      text: `{\n  "numStartups": 1,\n  "projects": {\n  }\n}\n`,
      expect: "entry",
    },
    {
      name: "entry-without-key",
      about: "the folder has an entry without the trust key",
      text: json({ ...base, projects: { [other]: otherEntry, [key]: ownEntry } }),
      expect: "field",
    },
    {
      name: "entry-false",
      about: "the trust key exists with another value (false); the undo restores it",
      text: json({ ...base, projects: { [key]: { ...ownEntry, hasTrustDialogAccepted: false } } }),
      expect: "value",
    },
    {
      name: "already-trusted",
      about: "the trust key is already true: nothing is written",
      text: json({ ...base, projects: { [key]: { ...ownEntry, hasTrustDialogAccepted: true } } }),
      expect: "none",
    },
    {
      name: "crlf-tabs-spacing",
      about: "CRLF line endings, tab indentation, spaces before colons, a blank line",
      text: crlfTabs,
      expect: "entry",
    },
    {
      name: "minified",
      about: "the whole file on one line",
      text: JSON.stringify({ ...base, projects: { [other]: { hasTrustDialogAccepted: true } } }),
      expect: "entry",
    },
    {
      name: "escaped-key",
      about: "the folder's entry spelled with \\u escapes, matched by value",
      text: `{\n  "projects": {\n    ${escapedKey}: {\n      "hasTrustDialogAccepted": false\n    }\n  }\n}\n`,
      expect: "value",
    },
    {
      name: "bom",
      about: "a byte order mark before the object",
      text: `\uFEFF${json({ numStartups: 2 })}`,
      expect: "container",
    },
  ];
}

/** Codex `config.toml` cases for project key `key`; `other` is another folder's key. */
export function codexCases(key: string, other: string, quote: (k: string) => string): Case[] {
  const settings = [
    "# Codex settings, kept by hand",
    'model = "fixture-model"',
    'model_reasoning_effort = "medium"',
    "",
    "[mcp_servers.fixture]",
    'command = "node"',
    "args = [",
    '  "server.js",',
    '  "--flag", # a comment inside the array',
    "]",
    "",
    "[tui]",
    'notifications = ["agent-turn-complete"]',
  ];
  const projects = [
    `[projects.${quote(other)}]`,
    'trust_level = "trusted"',
    "",
    `[projects.${quote(`${other}-2`)}]`,
    'trust_level = "untrusted"',
  ];
  const lf = (lines: string[]) => `${lines.join("\n")}\n`;
  const basic = `"${key
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
  return [
    { name: "no-file", about: "the file did not exist", text: null, expect: "file" },
    {
      name: "no-projects",
      about: "comments, other tables, a multi-line array, no newline at the end",
      text: settings.join("\n"),
      expect: "entry",
    },
    {
      name: "other-projects",
      about: "other folders' project tables",
      text: lf([...settings, "", ...projects]),
      expect: "entry",
    },
    {
      name: "comments-whitespace",
      about:
        "spaced headers, tabs, trailing comments, a multi-line string holding a header-like line",
      text: lf([
        "   # leading comment",
        `[ projects . ${quote(other)} ]   # by hand`,
        '\ttrust_level="trusted"   # spaced',
        "",
        "",
        "[notes]",
        // A multi-line literal string: a basic one would read the backslashes of a Windows path
        // as escapes, which Codex rejects.
        "text = '''",
        `[projects.${quote(key)}]`,
        'trust_level = "untrusted"',
        "'''",
        "   ",
      ]),
      expect: "entry",
    },
    {
      name: "crlf",
      about: "CRLF line endings",
      text: `${[...settings, "", ...projects].join("\r\n")}\r\n`,
      expect: "entry",
    },
    {
      name: "entry-untrusted",
      about: "the folder's table exists with another value; the undo restores it",
      text: lf([
        ...settings,
        "",
        ...projects,
        "",
        `[projects.${quote(key)}]`,
        'trust_level = "untrusted" # kept',
      ]),
      expect: "value",
    },
    {
      name: "entry-without-key",
      about: "the folder's table exists without trust_level (only a comment)",
      text: lf([`[projects.${quote(key)}]`, "# added by hand", "", "[tui]", "animations = false"]),
      expect: "field",
    },
    {
      name: "already-trusted",
      about: "already trusted: nothing is written",
      text: lf([...settings, "", `[projects.${quote(key)}]`, 'trust_level = "trusted"']),
      expect: "none",
    },
    {
      name: "basic-string-key",
      about: "the folder's table spelled as a basic string with escapes",
      text: lf([`[projects.${basic}]`, "trust_level = 'untrusted'"]),
      expect: "value",
    },
    {
      name: "bom",
      about: "a byte order mark before the first line",
      text: `\uFEFF${lf(settings)}`,
      expect: "entry",
    },
    {
      name: "inline-projects",
      about: "projects as an inline table: refused, file untouched",
      text: lf([`projects = { ${basic} = { trust_level = "untrusted" } }`]),
      expect: "refused",
    },
    {
      name: "bare-projects-table",
      about: "a [projects] table with dotted keys: refused, file untouched",
      text: lf(["[projects]", `${basic}.trust_level = "untrusted"`]),
      expect: "refused",
    },
  ];
}
