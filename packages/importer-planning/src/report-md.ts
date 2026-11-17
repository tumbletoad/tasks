// report.md (A7 3.15.4): the dry run's report for a person, from report.json's values only. It
// stays in the space's run folder on its machine. The words around the values are fixed; the
// values that are the person's own (area, project and owner names) are written as they are, with
// the characters Markdown would read escaped.

import type { ImportPlanningPreviewResult } from "@tasks/contracts";

type Report = ImportPlanningPreviewResult;

/**
 * A value as text, in a table cell or a list item: no line break, every character that marks up
 * inline text escaped with a backslash (CommonMark allows one before any ASCII punctuation), and a
 * start that would open a block inside a list item escaped too. So a pipe, an emphasis, a link, an
 * HTML tag or entity (`&copy;`), a list marker (`- x`, `+ x`, `1. x`), a rule or a heading stays
 * text wherever the value stands.
 */
function cell(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/([\\|*_`[\]<>#&!~])/g, "\\$1")
    .replace(/^(\s*)([-+=])/u, "$1\\$2")
    .replace(/^(\s*\d{1,9})([.)])/u, "$1\\$2");
}

const NOT_IMPORTED: Readonly<Record<Report["not_imported"][number]["what"], string>> = {
  code: "planning.py, assets/, index.html and tests/: code, never run. They stay in the frozen folder",
  agent_rules:
    "The prototype's agent files: move the rules that still matter by hand into the Refresh sources and the instructions",
  snapshots: "snapshots/: old copies of the ledgers. They stay in the frozen folder",
  notes:
    "context/ and reviews/: background notes and refresh reports. They stay in the frozen folder",
  ticket_inventory:
    "data/jira.json: a ticket inventory, not tasks. Its ticket titles title the ticket sources",
  audit: "data/audit.json: review times and coverage, copied into the run folder",
  unready_events:
    "web- events without their .ready file: unfinished browser writes, skipped as the prototype skips them",
  raw_events: "The events themselves: folded into each task's check-off and star, copied",
  orphans:
    "Metadata entries without a task line: not created (--include-orphans creates those whose ID a task line could carry)",
  browser_actions:
    "Check-offs and stars the page holds only in its browser storage: save the page's actions export and run the dry run again with --actions <file>",
};

const PROJECT_NONE: Readonly<
  Record<NonNullable<Report["project_folders"][number]["none"]>, string>
> = {
  no_folders: "none: none of its tasks has a folder on this machine",
  no_common_folder: "none: no task's folder holds all the others",
  taken: "none: another project has that folder",
};

const TASK_FOLDER: Readonly<
  Record<NonNullable<Report["tasks"][number]["folder"]>["state"], string>
> = {
  own: "",
  project: " (the project's)",
  missing: " (not on this machine: no folder)",
  other_machine: " (another kind of machine's path: no folder)",
  reserved: " (inside this app's own data: no folder)",
};

/** report.md's text. */
export function renderPreview(r: Report): string {
  const c = r.counts;
  const out: string[] = [];
  const line = (text = "") => out.push(text);
  const row = (...cells: (string | number)[]) =>
    line(`| ${cells.map((v) => cell(String(v))).join(" | ")} |`);
  /** A table's header: its titles, then the delimiter row, which is markup, never a value. */
  const head = (...titles: string[]) => {
    row(...titles);
    line(`|${titles.map(() => " --- ").join("|")}|`);
  };

  line("# Planning prototype import: dry run");
  line();
  line(`Run \`${r.run}\`. Days are placed in the time zone ${cell(r.time_zone)}.`);
  line();
  if (r.blocked) {
    const errors = r.attention.filter((a) => a.severity === "error");
    line(
      `**Blocked.** ${String(errors.reduce((n, a) => n + a.count, 0))} errors must be fixed in the prototype folder before this import can be applied. Run the dry run again afterwards.`,
    );
  } else {
    line(`Ready to apply with the preview token \`${r.token ?? ""}\`.`);
  }
  line();
  line("Nothing was written to the space: this run folder holds the input copy and this report.");
  line();

  line("## 1. Counts and reconciliation");
  line();
  head("What", "Count");
  row("Task lines in TODO.md", c.todo_task_lines);
  row("Task lines in DONE.md", c.done_task_lines);
  row("Metadata entries", c.metadata_entries);
  row("Metadata entries without a task line", c.metadata_orphans);
  row("Task lines without metadata", c.task_lines_without_metadata);
  row(
    "Event files (counted, without .ready)",
    `${String(c.event_files)} (${String(c.counted_event_files)}, ${String(c.events_not_ready)})`,
  );
  row(
    "Events in the actions export (added)",
    `${String(c.actions_events)} (${String(c.actions_added)})`,
  );
  row(
    "Tasks to create (active, completed)",
    `${String(c.tasks)} (${String(c.active)}, ${String(c.completed)})`,
  );
  row("Of the completed, wrapped up", c.wrapped);
  row("Aliases", c.aliases);
  row("Areas (the space has)", `${String(c.areas)} (${String(c.areas_existing)})`);
  row("Projects (the space has)", `${String(c.projects)} (${String(c.projects_existing)})`);
  row("Sources (the space has)", `${String(c.sources)} (${String(c.sources_existing)})`);
  row("Links to sources", c.links);
  row("Task folders (not on this machine)", `${String(c.folders)} (${String(c.folders_missing)})`);
  row("Projects that get a folder", c.project_folders);
  row("Lines left out for an ID another line has", c.duplicates_left_out);
  row("Orphans created", c.orphans_included);
  row("Texts the sanitiser changed", c.text_sanitised);
  row("Inputs that changed during the run", c.source_changes);
  line();
  line(
    r.reconciled
      ? "Every task line is one task or a line left out for its ID: active plus completed equals the task lines."
      : "**The counts do not reconcile:** active plus completed is not the task lines.",
  );
  line();
  for (const k of r.sources_by_kind) line(`- ${cell(k.kind)}: ${String(k.count)}`);
  if (r.sources_by_kind.length > 0) line();

  line("## 2. Status mapping");
  line();
  head("Prototype", "Here", "Tasks");
  for (const s of r.statuses) row(s.prototype, s.status, s.count);
  line();

  line("## 3. Project folders");
  line();
  line(
    "A project gets the folder of one of its tasks that holds every other task folder of the project. A task whose folder is the project's gets none of its own; the other tasks keep theirs.",
  );
  line();
  head("Project", "Area", "Folder on this machine");
  for (const p of r.project_folders) {
    const folder =
      p.folder ??
      (p.none === "taken"
        ? `none: ${p.holder ?? "another project"} has that folder`
        : PROJECT_NONE[p.none ?? "no_folders"]);
    row(p.project, p.area, folder);
    if (p.current !== undefined) {
      line(
        `|  |  | ${cell(`has ${p.current} here now: kept unless only the prototype changed it`)} |`,
      );
    }
  }
  if (r.project_folders.length === 0) line("No projects.");
  if (r.tasks.some((t) => t.folder?.state === "other_machine")) {
    line();
    line(
      "Some folders are paths of another kind of machine. Run the import on the machine they are on to give the tasks and projects their folders.",
    );
  }
  line();

  line("## 4. Needs attention");
  line();
  if (r.attention.length === 0) line("Nothing.");
  for (const a of r.attention) {
    line(`- \`${a.code}\` (${a.severity}): ${String(a.count)}`);
    for (const p of r.problems.filter((x) => x.code === a.code)) {
      const where = [
        p.file,
        p.line === undefined ? undefined : `line ${String(p.line)}`,
        p.task,
        p.field,
        p.index === undefined ? undefined : `#${String(p.index)}`,
      ].filter((v) => v !== undefined);
      line(`  - ${cell(where.join(", "))}`);
    }
  }
  if (r.problems_more > 0) line(`- ${String(r.problems_more)} more in report.json`);
  line();
  line("Owners:");
  line();
  for (const o of r.owners) {
    line(`- ${cell(o.name)}: ${String(o.tasks)} tasks${o.me ? " (you: no owner)" : ""}`);
  }
  if (r.owners.length === 0) line("- none");
  line();

  line("## 5. Per task");
  line();
  head("Legacy ID", "Reference", "Area", "Project", "Status", "Folder", "Due", "Focus");
  for (const t of r.tasks) {
    const status = t.lifecycle === "completed" ? `completed (${t.wrap ?? "pending"})` : t.status;
    const folder = t.folder === undefined ? "" : `${t.folder.path}${TASK_FOLDER[t.folder.state]}`;
    row(
      t.legacy_id + (t.imported === true ? " (in the space)" : ""),
      t.ref,
      t.area,
      t.project ?? "",
      status,
      folder,
      t.due ?? "",
      t.focus ?? "",
    );
  }
  if (r.tasks_more > 0) line(`\n${String(r.tasks_more)} more in report.json.`);
  line();

  line("## 6. Not imported");
  line();
  for (const n of r.not_imported) {
    line(`- ${NOT_IMPORTED[n.what]}${n.count === undefined ? "" : `: ${String(n.count)}`}`);
  }
  line();
  return out.join("\n");
}
