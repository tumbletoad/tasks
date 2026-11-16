// Finds text that describes one person's own machines in the repository: a machine's role as if
// every reader knew it, a path under a real home, an OS build number. The repository is public, so
// such text names the platform instead ("on Windows 11", "on Ubuntu 24.04").
//
// Text is read with its line breaks and leading comment markers folded into single spaces, so a
// phrase split over two lines of a comment is still one phrase.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Finding {
  file: string;
  line: number;
  found: string;
  advice: string;
}

const PLATFORM = 'Name the platform instead: "on Windows 11", "on Ubuntu 24.04".';
const PATH =
  "Use a fixture home (/home/mira, C:\\Users\\mira), a placeholder (<user>, <s> for a scratch folder) or ~ with a generic folder.";

// Home folder names the fixtures and examples use, and the CI runners' accounts. A name of one or
// two letters is a placeholder too. Compared without case, accents, an extension (a test of the
// reserved name nul.txt) or a Windows 8.3 suffix (RUNNER~1).
const FIXTURE_HOMES = new Set([
  "mira",
  "ada",
  "jonas",
  "other",
  "someone",
  "user",
  "you",
  "name",
  "nul",
  "off",
  "runner",
  "runneradmin",
  "public",
  "default",
]);

export function isFixtureHome(name: string): boolean {
  const plain = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/~\d+$/, "")
    .replace(/\..*$/, "")
    .replace(/-+$/, "");
  return plain.length <= 2 || FIXTURE_HOMES.has(plain) || /fixture|sentinel/.test(plain);
}

interface Rule {
  pattern: RegExp;
  advice: string;
  /** The home name in group 1 must be a real one for the match to count. */
  home?: true;
}

const HOME_NAME = "([\\p{L}\\p{N}._~-]+)";
const SEP = "(?:\\\\{1,2}|/)";

const RULES: Rule[] = [
  { pattern: /\b(?:reference|lab)\s+machines?\b/giu, advice: PLATFORM },
  { pattern: /\bthe\s+test\s+machines?\b/giu, advice: PLATFORM },
  {
    pattern:
      /\b(?:maintainer|owner)['’]?s\s+(?:own\s+)?(?:machine|computer|laptop|desktop|pc)s?\b/giu,
    advice: `${PLATFORM} Where a step needs a person, say what it needs ("by hand, outside CI").`,
  },
  // "the laptop" and "on the desktop" alone are not checked: they are ordinary words in help text
  // (a laptop's lid, a notification on the desktop) and in task examples.
  { pattern: /\bthe\s+(?:desktop|laptop)\s+(?:machine|computer|pc)s?\b/giu, advice: PLATFORM },
  { pattern: /~[\\/]Dev[\\/]/gu, advice: PATH },
  { pattern: new RegExp(`(?<![\\w.~-])/home/${HOME_NAME}`, "gu"), advice: PATH, home: true },
  { pattern: new RegExp(`(?<![\\w.~-])/Users/${HOME_NAME}`, "gu"), advice: PATH, home: true },
  {
    pattern: new RegExp(`\\b[a-z]:${SEP}users${SEP}${HOME_NAME}`, "giu"),
    advice: PATH,
    home: true,
  },
  {
    pattern:
      /(?:%USERPROFILE%|\$env:USERPROFILE|\$HOME|~)[\\/]+tasks-test\b|\btasks-test[\\/]+m0-/giu,
    advice: PATH,
  },
  // The version line a Windows machine prints. A build named in words ("Windows 11 build 26100 or
  // later") is a requirement a person may need to read, so it passes.
  {
    pattern: /\b10\.0\.2\d{4}\b/gu,
    advice: `An OS build number describes one machine. ${PLATFORM}`,
  },
];

/** The comment markers a line may start with, also nested (`> //`): `//`, `/*`, `*`, `#`, `>`, `<!--`, `--`, `;`, `rem`. */
const LEADING_MARKERS = /^\s*(?:(?:\/\/+|\/\*+|\*+\/?|#+|>+|<!--|--|;+|rem\b)\s*)*/iu;

/**
 * Folds a text's lines into one, each line's leading comment markers removed. A line left empty
 * ends a paragraph: it folds to a mark that no rule reads across, so a heading and the paragraph
 * under it never form a phrase.
 */
export function fold(text: string): { folded: string; starts: number[] } {
  const starts: number[] = [];
  let folded = "";
  for (const line of text.split(/\r?\n/)) {
    starts.push(folded.length);
    const content = line.replace(LEADING_MARKERS, "").trimEnd();
    folded += content === "" ? "¶ " : `${content} `;
  }
  return { folded, starts };
}

function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The machine facts in one text. */
export function findMachineFacts(file: string, text: string): Finding[] {
  const { folded, starts } = fold(text);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const m of folded.matchAll(rule.pattern)) {
      if (rule.home === true && isFixtureHome(m[1] ?? "")) continue;
      findings.push({
        file,
        line: lineOf(starts, m.index),
        found: m[0],
        advice: rule.advice,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Files not read, with the reason:
 * - this check and its test hold the phrases on purpose;
 * - the lockfile is generated and holds no prose.
 * Binary files are skipped by content (a NUL byte).
 */
export const SKIPPED = new Set([
  "scripts/machine-facts.ts",
  "scripts/machine-facts.test.ts",
  "pnpm-lock.yaml",
]);

/** Tracked files, and new files git does not ignore, so a finding shows before the commit. */
export function repositoryFiles(root: string): string[] {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return [...new Set(listed.stdout.split("\0"))].filter((f) => f !== "" && !SKIPPED.has(f));
}

/** The machine facts in every file of the repository at `root`. */
export function scanRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of repositoryFiles(root)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, file));
    } catch {
      continue; // listed in the index but deleted in the working tree
    }
    if (bytes.includes(0)) continue;
    findings.push(...findMachineFacts(file, bytes.toString("utf8")));
  }
  return findings;
}

export function explain(finding: Finding): string {
  return `${finding.file}:${String(finding.line)}: "${finding.found}". ${finding.advice}`;
}
