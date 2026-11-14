// The optional files (A7 3.15.7; A7 3.15.2, Optional files). Neither holds tasks.
// - data/jira.json: a list of ticket rows (missing: []). A row without `key` is skipped; `key` and
//   `url` (path /browse/<KEY>) are read, and other fields are free. Its `summary` is the ticket's
//   title, which fills the title of a matching ticket source (M7.03).
// - data/audit.json: one free-form object (missing: {}) with a scalar `reviewed` time, offered as
//   the Refresh watermark, and nested objects or lists that the page only displays.

import { eventInstant } from "./events.ts";
import { isObject, readJson } from "./json.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { problem, type Problem } from "./problems.ts";
import type { Source } from "./text.ts";

export const JIRA_FILE = "data/jira.json";
export const AUDIT_FILE = "data/audit.json";

export interface JiraTicket {
  readonly key: string;
  readonly url?: string;
  /** The row's `summary`, when it is text. */
  readonly title?: string;
  /** The whole row as written. */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface JiraParse {
  readonly present: boolean;
  readonly tickets: readonly JiraTicket[];
  /** Rows left out because they have no text `key`. */
  readonly skippedRows: number;
  readonly problems: Problem[];
}

export function parseJira(source: Source | undefined, overrides?: Partial<Limits>): JiraParse {
  const limits = limitsWith(overrides);
  if (source === undefined) return { present: false, tickets: [], skippedRows: 0, problems: [] };
  const read = readJson(source, JIRA_FILE, limits.jsonBytes);
  const problems = read.problems;
  const tickets: JiraTicket[] = [];
  let skippedRows = 0;
  if (!read.ok) return { present: true, tickets, skippedRows, problems };
  if (!Array.isArray(read.value)) {
    problems.push(problem("json-wrong-shape", { file: JIRA_FILE }));
    return { present: true, tickets, skippedRows, problems };
  }
  for (const [index, row] of (read.value as unknown[]).entries()) {
    if (index >= limits.entries) {
      problems.push(problem("too-many-entries", { file: JIRA_FILE, index }));
      break;
    }
    const key = isObject(row) ? row["key"] : undefined;
    if (!isObject(row) || typeof key !== "string" || key === "") {
      skippedRows += 1;
      problems.push(problem("jira-row-without-key", { file: JIRA_FILE, index }));
      continue;
    }
    const ticket: { -readonly [K in keyof JiraTicket]: JiraTicket[K] } = { key, fields: row };
    if (typeof row["url"] === "string") ticket.url = row["url"];
    if (typeof row["summary"] === "string") ticket.title = row["summary"];
    tickets.push(ticket);
  }
  return { present: true, tickets, skippedRows, problems };
}

export interface AuditParse {
  readonly present: boolean;
  /** The scalar `reviewed` time, when it is an RFC 3339 time with a zone. */
  readonly reviewed?: string;
  /** The whole object as written. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly problems: Problem[];
}

export function parseAudit(source: Source | undefined, overrides?: Partial<Limits>): AuditParse {
  const limits = limitsWith(overrides);
  if (source === undefined) return { present: false, fields: {}, problems: [] };
  const read = readJson(source, AUDIT_FILE, limits.jsonBytes);
  const problems = read.problems;
  if (!read.ok) return { present: true, fields: {}, problems };
  if (!isObject(read.value)) {
    problems.push(problem("json-wrong-shape", { file: AUDIT_FILE }));
    return { present: true, fields: {}, problems };
  }
  const fields = read.value;
  const reviewed = fields["reviewed"];
  if (typeof reviewed === "string" && eventInstant(reviewed) !== undefined) {
    return { present: true, reviewed, fields, problems };
  }
  if (reviewed !== undefined && reviewed !== null) {
    problems.push(problem("date-invalid", { file: AUDIT_FILE, field: "reviewed" }));
  }
  return { present: true, fields, problems };
}
