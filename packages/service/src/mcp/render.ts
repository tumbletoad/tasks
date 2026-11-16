// The compact text of each tool's result and of every error (A3 3.3 "Results", 3.4's examples,
// 3.5's text form, 3.9.6's digest, 3.10's framing). The text is the entry's rendering of the
// structured result that `op/call` returns, so every face reports the same outcome: the MCP
// contract suite holds the two equal. text.ts frames stored text and fits the budget.
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import {
  LIMITS,
  findEntry,
  messageWithHint,
  type ErrorBody,
  type OutputOf,
} from "@tasks/contracts";
import { toolOf } from "./tools.ts";
import {
  clip,
  entryLines,
  fit,
  fixed,
  textLines,
  type Part,
  type Random,
  type Rendered,
} from "./text.ts";

/** A3 3.2.5: an error, with up to three candidate rows. */
export const ERROR_TOKENS = 300;
/** A3 3.9.6: the digest of `get_task` without sections. */
export const DIGEST_TOKENS = 1_200;

type Status = OutputOf<"space.status">;
type TaskGet = OutputOf<"task.get">;

/** The fields of A3's task row (contracts' TaskRow) a line shows. */
interface RowLike {
  readonly ref: string;
  readonly title: string;
  readonly lifecycle: string;
  readonly status: string;
  readonly inbox: boolean;
  readonly priority: number;
  readonly effort?: string | undefined;
  readonly due?: string | { readonly at: string; readonly tz: string } | undefined;
  readonly area?: string | undefined;
  readonly project?: string | undefined;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `2026-11-13 (Fri)` for an ISO date. */
function withWeekday(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const name = WEEKDAYS[day];
  return name === undefined ? date : `${date} (${name})`;
}

function dueText(due: RowLike["due"]): string | undefined {
  if (due === undefined) return undefined;
  return typeof due === "string" ? withWeekday(due) : `${due.at} ${due.tz}`;
}

const join = (...parts: (string | false | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");

const group = (row: Pick<RowLike, "area" | "project">): string | undefined =>
  row.area === undefined && row.project === undefined
    ? undefined
    : [row.area, row.project].filter((name) => name !== undefined).join(" / ");

/** One task as a list line: ref, state, priority, effort, due, title. Stored names: data only. */
function rowLine(row: RowLike): string {
  return join(
    row.ref,
    row.lifecycle !== "active" && row.lifecycle,
    row.status,
    `P${String(row.priority)}`,
    row.effort,
    row.due !== undefined && `due ${dueText(row.due) ?? ""}`,
    row.inbox && "inbox",
    clip(row.title, 200),
  );
}

const replayed = (result: { readonly replayed?: boolean | undefined }): string =>
  result.replayed === true ? " (replayed)" : "";

// ---------------------------------------------------------------------------------------------
// space.status (A3 3.4.2)

function sessionLine(session: Status["session"]): string {
  const state =
    session.state === "bound"
      ? `bound to ${session.task ?? "a task"}`
      : session.state === "routine"
        ? "routine"
        : "not bound";
  return `Session: ${join(
    state,
    session.instance !== undefined && `instance ${session.instance}`,
    session.app,
    session.notes_for_agents !== undefined &&
      `${String(session.notes_for_agents)} notes from the user for agents`,
    session.proposals_rejected !== undefined &&
      `${String(session.proposals_rejected)} proposals rejected`,
  )}`;
}

function statusParts(result: Status, bound?: boolean): Part[] {
  const counts = result.counts;
  const header = fixed(
    `${join(PRODUCT_NAME, withWeekday(result.date), result.time_zone, `autonomy ${result.autonomy}`)} · as_of ${result.as_of}`,
    sessionLine(result.session),
    bound === true ? "This call bound the session." : undefined,
  );
  // A guide is one workflow text instead of the overview (A3 3.4.2).
  if (result.guide !== undefined) return [header, fixed(...result.guide.split("\n"))];
  const parts: Part[] = [
    header,
    {
      data: true,
      fixed: true,
      units: [[`Space: ${result.space.name} (${result.space.ref_prefix})`]],
    },
  ];
  if (result.here !== undefined) {
    parts.push({
      data: true,
      total: result.here_total ?? result.here.length,
      title: (kept, total) =>
        total === 0
          ? "Here: no task for this folder"
          : `Here (${String(kept)} of ${String(total)}):`,
      units: result.here.map((row) => [
        `  ${join(
          rowLine(row),
          row.match,
          row.live_sessions > 0 &&
            `${String(row.live_sessions)} live session${row.live_sessions === 1 ? "" : "s"}`,
        )}`,
      ]),
    });
  }
  parts.push({
    data: true,
    fixed: true,
    units: [
      [
        `Counts: ${join(
          ...counts.statuses.map((s) => `${s.status} ${String(s.count)}`),
          `inbox ${String(counts.inbox)}`,
          `proposals ${String(counts.proposals)}`,
        )}`,
      ],
    ],
  });
  for (const section of result.sections ?? []) {
    parts.push({
      data: true,
      title: (kept, total) => `${section.name} (${String(kept)} of ${String(total)}):`,
      units: section.tasks.map((row) => [`  ${rowLine(row)}`]),
    });
  }
  if (result.hint !== undefined) parts.push(fixed(result.hint));
  return parts;
}

/** A3 3.2.5: a guide's budget. */
export const GUIDE_TOKENS = 900;

/** How to see what a status left out: its rows are cut last-first. */
const STATUS_MORE = "Pass a deeper cwd, or ask for fewer include sections.";

// ---------------------------------------------------------------------------------------------
// task.get (A3 3.4.4, 3.9.6)

type Slice = { readonly from: number; readonly to: number; readonly of: number };
type Note = {
  readonly ref: string;
  readonly author: string;
  readonly for_agents: boolean;
  readonly at: string;
  readonly text: string;
  readonly cut?: number | undefined;
  readonly slice?: Slice | undefined;
};
type LogEntry = {
  readonly ref: string;
  readonly kind: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly cut?: number | undefined;
  readonly slice?: Slice | undefined;
};
type Source = {
  readonly key?: string | undefined;
  readonly kind: string;
  readonly title: string;
  readonly who?: string | undefined;
  readonly url?: string | undefined;
  readonly cut?: number | undefined;
};

const day = (at: string): string => at.slice(0, 10);

/** A note the user addressed to agents: the only stored text presented as instructions (A3 3.10). */
const isInstruction = (note: Note): boolean => note.for_agents && note.author === "user";

/** What the digest left out of a text, said where the text ends (A3 3.9.6). */
const withCut = (text: string, cut: number | undefined): string =>
  cut === undefined ? text : `${text}... (+${String(cut)} chars)`;

/** The range of a text a page holds, before the text: `(chars 4001-8000 of 65536) `. */
const rangeOf = (slice: Slice | undefined): string =>
  slice === undefined
    ? ""
    : `(chars ${String(slice.from + 1)}-${String(slice.to)} of ${String(slice.of)}) `;

/**
 * The digest's notes the user addressed to agents, outside the data block, each whole: the request
 * path took them whole or not at all (A3 3.9.6), and the budget leaves out whole notes only, behind
 * the overflow line, which counts every note the digest does not show.
 */
function instructionsPart(
  notes: readonly Note[],
  total: number,
  getTask: string,
  ref: string,
): Part {
  return {
    units: notes.map((note) => entryLines(`- ${day(note.at)} `, note.text)),
    total,
    title: (kept, all) =>
      all === 0
        ? undefined
        : `From the user, for agents (${kept < all ? `${String(kept)} of ${String(all)} shown` : `${String(all)} of ${String(all)}`}):`,
    // The task by its reference: a session that is not bound to it can follow the line as it is.
    overflow: () => [
      `Load the rest with ${getTask} task "${ref}" sections ["instructions"] before you start.`,
    ],
  };
}

const noteLines = (note: Note): string[] =>
  entryLines(
    `- ${note.ref} [${note.author}] ${day(note.at)} ${rangeOf(note.slice)}`,
    withCut(note.text, note.cut),
  );

const logLines = (entry: LogEntry): string[] =>
  entryLines(
    `- ${entry.ref} ${day(entry.at)} [${entry.author}] ${entry.kind}: ${rangeOf(entry.slice)}`,
    withCut(entry.text, entry.cut),
  );

const sourceLine = (source: Source): string =>
  `- ${join(`[${source.kind}] "${withCut(source.title, source.cut)}"`, source.who, source.key !== undefined && `key ${source.key}`, source.url)}`;

function headerLine(
  task: RowLike & { readonly wrap_state?: string | undefined },
  asOf: string,
): string {
  return `${join(
    task.ref,
    task.lifecycle,
    task.wrap_state,
    `P${String(task.priority)}`,
    task.due !== undefined && `due ${dueText(task.due) ?? ""}`,
    task.inbox && "inbox",
  )} · as_of ${asOf}`;
}

type DigestTask = Extract<TaskGet, { view: "digest" }>["task"];

/**
 * The header's place line: the folder Tasks resolved on this machine now (a path Tasks resolved,
 * which stands outside the data block, A3 3.9.6, 3.10), or why there is none (R11), as a code.
 */
function placeLine(place: NonNullable<DigestTask["place"]>): string {
  if (place.folder !== undefined) {
    return `Place: ${place.root}:${place.path} -> ${place.folder} (this machine)`;
  }
  const reason = place.unresolved !== undefined && WORD.test(place.unresolved);
  return `Place: unresolved here (${reason ? (place.unresolved ?? "") : "unknown"})`;
}

/**
 * A place that resolves to nothing here: its stored root and path are text someone wrote, so they
 * stand inside the data block (A3 3.10: only paths Tasks resolved stand outside).
 */
const storedPlace = (place: DigestTask["place"]): string[][] =>
  place === undefined || place.folder !== undefined
    ? []
    : [[`Place: ${clip(`${place.root}:${place.path}`, 200)} (as stored)`]];

const SECTION_NAMES = ["context", "notes", "log", "sources", "outcome", "history"];

function digestRendered(result: Extract<TaskGet, { view: "digest" }>, getTask: string): Rendered {
  const task = result.task;
  const { more } = task;
  const cut = task.cut ?? {};
  const parts: Part[] = [
    fixed(
      headerLine(task, result.as_of),
      task.place === undefined ? undefined : placeLine(task.place),
      result.bound ? "Session: bound to this task by this call" : undefined,
    ),
    instructionsPart(
      task.instructions,
      task.instructions.length + more.instructions,
      getTask,
      task.ref,
    ),
    {
      data: true,
      fixed: true,
      units: [
        [`Title: ${withCut(task.title, cut.title)}`],
        [
          `Status: ${join(task.status, task.effort !== undefined && `Effort: ${task.effort}`, group(task) !== undefined && `Group: ${group(task) ?? ""}`)}`,
        ],
        ...storedPlace(task.place),
      ],
    },
    {
      data: true,
      units: [
        ...(task.summary === "" ? [] : [[`Summary: ${withCut(task.summary, cut.summary)}`]]),
        ...(task.waiting_on === undefined ? [] : [[`Waiting on: ${clip(task.waiting_on, 80)}`]]),
        ...(task.focus ? [["Focus: today"]] : []),
      ],
    },
    {
      data: true,
      total: task.notes.length + more.notes,
      title: (kept, total) =>
        total === 0 ? undefined : `Notes (${String(kept)} of ${String(total)})`,
      units: task.notes.map(noteLines),
    },
    {
      data: true,
      title: (_kept, total) => (total === 0 ? undefined : "Context"),
      units: task.context === "" ? [] : [textLines(withCut(task.context, cut.context), "  ")],
    },
    {
      data: true,
      total: task.log.length + more.log,
      title: (kept, total) =>
        total === 0 ? undefined : `Log, newest (${String(kept)} of ${String(total)})`,
      units: task.log.map(logLines),
    },
    {
      data: true,
      total: task.sources.length + more.sources,
      title: (kept, total) =>
        total === 0 ? undefined : `Sources (${String(kept)} of ${String(total)})`,
      units: task.sources.map((source) => [sourceLine(source)]),
    },
    {
      data: true,
      title: (_kept, total) => (total === 0 ? undefined : "Learnings"),
      units: task.learnings.slice(0, 3).map((learning) => [`- ${clip(learning, 200)}`]),
    },
    ...(task.outcome === undefined
      ? []
      : [{ data: true, units: [[`Outcome: ${withCut(task.outcome, cut.outcome)}`]] }]),
    fixed(`More: ${getTask} task "${task.ref}" sections ${JSON.stringify(SECTION_NAMES)}`),
  ];
  return { parts, more: `Load them with ${getTask} sections.` };
}

/**
 * A page of a sections read. The request path sized the page to fit the budget whole (ops/pages.ts),
 * so nothing here is cut: each text is shown in full, or the part of it the page holds with its
 * range, and the way on is the page's before token.
 */
function sectionsRendered(
  result: Extract<TaskGet, { view: "sections" }>,
  getTask: string,
): Rendered {
  const { task, sections } = result;
  // A page never needs cutting; `clip` is the fit's last resort for a result built otherwise.
  const section = (title: string, units: string[][], data = true): Part => ({
    ...(data ? { data: true, clip: true } : {}),
    title: () => (units.length === 0 ? `${title} none` : title),
    units,
  });
  const parts: Part[] = [fixed(headerLine(task, result.as_of))];
  if (result.bound) parts.push(fixed("Session: bound to this task by this call"));
  let byOthers: Note[] = [];
  if (sections.instructions !== undefined) {
    // Only what the user wrote stands outside the data block as instructions (A3 3.10).
    const mine = sections.instructions.filter(isInstruction);
    byOthers = sections.instructions.filter((note) => !isInstruction(note));
    if (mine.length > 0 || byOthers.length === 0) {
      parts.push(
        section(
          "From the user, for agents:",
          mine.map((note) => entryLines(`- ${day(note.at)} ${rangeOf(note.slice)}`, note.text)),
          false,
        ),
      );
    }
  }
  // The title only names the task: A3 3.9.6's 200 characters, the rest said.
  parts.push({ data: true, fixed: true, units: [[`Title: ${clip(task.title, 200)}`]] });
  if (byOthers.length > 0) parts.push(section("Notes for agents:", byOthers.map(noteLines)));
  if (sections.context !== undefined) {
    parts.push({
      data: true,
      clip: true,
      title: () => `Context ${rangeOf(sections.context_slice)}`.trimEnd() + ":",
      units: sections.context === "" ? [["  (none)"]] : [textLines(sections.context, "  ")],
    });
  }
  if (sections.notes !== undefined) parts.push(section("Notes:", sections.notes.map(noteLines)));
  if (sections.log !== undefined) {
    parts.push(section("Log, newest first:", sections.log.map(logLines)));
  }
  if (sections.sources !== undefined) {
    parts.push(
      section(
        "Sources:",
        sections.sources.map((source) => [sourceLine(source)]),
      ),
    );
  }
  if (sections.outcome !== undefined) {
    const { outcome, wrap_state: wrap, learnings, slice } = sections.outcome;
    const state = wrap === undefined ? "" : ` (${wrap})`;
    // A page that holds learnings without the outcome's text may continue an earlier page, so it
    // names them alone rather than saying there is no outcome.
    const text = outcome !== undefined || slice !== undefined || learnings.length === 0;
    parts.push({
      data: true,
      clip: true,
      units: [
        text
          ? entryLines(`Outcome${state}: ${rangeOf(slice)}`, outcome ?? "none")
          : [`Learnings${state}:`],
        ...learnings.map((learning) => entryLines("- learning: ", learning)),
      ],
    });
  }
  if (sections.history !== undefined) {
    parts.push(
      section(
        "History, newest first:",
        sections.history.map((row) => [`- #${String(row.seq)} ${row.actor} ${row.what}`]),
      ),
    );
  }
  if (result.before !== undefined) {
    parts.push(
      fixed(
        `More: call ${getTask} task "${task.ref}" again with the same sections and before "${result.before}".`,
      ),
    );
  }
  return { parts, more: `Ask ${getTask} for fewer sections, or a smaller log_limit.` };
}

// ---------------------------------------------------------------------------------------------
// task.search (A3 3.4.3, 3.9.4)

type Search = OutputOf<"task.search">;
type SearchRow = Search["rows"][number];

/** A3 3.9.4: a title is cut at 90 characters, a snippet at 100, a learning at 200. */
const SEARCH_CUTS = { title: 90, snippet: 100, learning: 200 } as const;

/** One search row (A3 3.9.4): a task, a learning, or a placeholder for what went since. */
function searchLine(row: SearchRow): string {
  const changed = "changed" in row && row.changed === true ? " *" : "";
  switch (row.kind) {
    case "deleted":
    case "redacted":
      return `${row.ref} · ${row.kind} since this search`;
    case "learning":
      return `${join(row.task, row.date, group(row), `"${clip(row.text, SEARCH_CUTS.learning)}"`)}${changed}`;
    default: {
      const state =
        row.lifecycle === "active"
          ? row.status
          : join(row.lifecycle, row.completed).replaceAll(" · ", " ");
      const from =
        row.snippet_from === undefined || row.snippet_from === "task"
          ? ""
          : `${row.snippet_from}: `;
      // A finished task without a match in its text says how it ended in the summary's place.
      const line = row.snippet ?? row.ending;
      // A line that only repeats the title (a match in the title alone) costs tokens for nothing.
      const snippet =
        line === undefined || line === row.title
          ? ""
          : ` — ${from}${clip(line, SEARCH_CUTS.snippet)}`;
      return `${join(
        row.ref,
        state,
        `P${String(row.priority)}`,
        row.effort,
        row.due !== undefined && `due ${dueText(row.due) ?? ""}`,
        row.inbox && "inbox",
        group(row),
        clip(row.title, SEARCH_CUTS.title),
      )}${snippet}${changed}`;
    }
  }
}

function searchRendered(result: Search, search: string): Rendered {
  const { rows, first, total } = result;
  const span =
    rows.length <= 1
      ? String(rows.length === 0 ? 0 : first)
      : `${String(first)}-${String(first + rows.length - 1)}`;
  const changed = rows.some((row) => "changed" in row && row.changed === true);
  return {
    parts: [
      fixed(
        `${span} of ${String(total)} · scope ${result.scope} · as_of ${result.as_of}${changed ? " · * changed since the search ran" : ""}`,
      ),
      // The query as read: the caller's words, which may hold names copied from stored text.
      ...(result.parsed === ""
        ? []
        : [{ data: true, fixed: true, units: [[`Query: ${result.parsed}`]] }]),
      { data: true, units: rows.map((row) => [searchLine(row)]) },
      ...(result.cursor === undefined
        ? []
        : [fixed(`Next page: ${search} with cursor "${result.cursor}" and nothing else.`)]),
    ],
    more: `Call ${search} again with a smaller limit.`,
  };
}

// ---------------------------------------------------------------------------------------------
// task.add (A3 3.4.5), task.reopen (A3 3.4.9), run.report (A3 3.4.12)

type Added = OutputOf<"task.add">["tasks"][number];

/** At most this many references of an ambiguous match, then how many more. */
const AMBIGUOUS_SHOWN = 3;

/**
 * What became of the draft at `path` (A3 3.2.5, 3.4.5): created, or matched by its source key,
 * with its reference. Only the product's words and references, so the line is never cut and needs
 * no data block; the draft's title is the caller's own and is not echoed.
 */
function draftLine(row: Added, path: string): string {
  const refs = row.ambiguous ?? [];
  const what =
    row.result === "exists"
      ? row.ambiguous !== undefined
        ? `exists, several match: ${refs.slice(0, AMBIGUOUS_SHOWN).join(", ")}${refs.length > AMBIGUOUS_SHOWN ? ` and ${String(refs.length - AMBIGUOUS_SHOWN)} more` : ""}`
        : join(
            `exists ${row.ref ?? ""}`,
            row.lifecycle !== undefined && row.lifecycle !== "active" && row.lifecycle,
            row.matched_by === "source_key" && "by source key",
            row.log_added && "log added",
          )
      : `${row.result} ${row.ref ?? ""}`;
  return `${path}: ${what.trimEnd()}`;
}

/**
 * `add_tasks`' text (A3 3.4.5): the counts, every draft's line, never cut, then the warnings, which
 * a cut takes from the end, because 25 drafts' lines fit the budget alone (A3 3.2.5).
 */
function addRendered(result: OutputOf<"task.add">): Rendered {
  const created = result.tasks.filter((t) => t.result !== "exists").length;
  return {
    parts: [
      fixed(
        `${join(`${String(created)} created`, `${String(result.tasks.length - created)} existing`, result.proposal !== undefined && `proposal ${result.proposal}`)} · as_of ${result.as_of}${replayed(result)}`,
        ...result.tasks.map((row, k) => draftLine(row, `tasks.${String(k)}`)),
      ),
      { units: result.warnings.map((w) => [`warning: ${w}`]) },
    ],
    more: "Send fewer tasks per call to see every warning.",
  };
}

// ---------------------------------------------------------------------------------------------
// group.manage (A3 3.4.10): names are data, counts are not

type Groups = OutputOf<"group.manage">;

function groupsRendered(result: Groups, organize: string): Rendered {
  const project = (p: Groups["projects"][number]) => `${p.name} (${String(p.active)})`;
  const head = `${String(result.total_areas)} area${result.total_areas === 1 ? "" : "s"} · ${String(result.total_projects)} project${result.total_projects === 1 ? "" : "s"} · as_of ${result.as_of}${replayed(result)}`;
  const done =
    result.result === undefined
      ? undefined
      : join(
          result.result,
          result.group !== undefined && `${result.group.kind} ${result.group.id}`,
          result.proposal !== undefined && `proposal ${result.proposal}`,
        );
  return {
    parts: [
      fixed(done, head),
      {
        data: true,
        units: [
          ...result.areas.map((area) => [
            `${area.name} (${String(area.active)})`,
            ...(area.projects.length === 0
              ? []
              : [
                  `  ${area.projects.map(project).join(" · ")}${area.more_projects === undefined ? "" : ` · +${String(area.more_projects)} more`}`,
                ]),
          ]),
          ...(result.projects.length === 0
            ? []
            : [[`No area: ${result.projects.map(project).join(" · ")}`]]),
        ],
      },
    ],
    more: `Call ${organize} with action list and the area as path.`,
  };
}

// ---------------------------------------------------------------------------------------------
// prefs.manage (A3 3.4.11): keys are the product's words, values are data

type Prefs = OutputOf<"prefs.manage">;

const prefText = (value: unknown): string => JSON.stringify(value);

function prefsRendered(result: Prefs): Rendered {
  const row = (p: Prefs["prefs"][number]): string[] => {
    const who =
      p.policy === true ? "policy, the user's" : p.writable ? "you may set it" : "the user's";
    if (result.action === "describe") {
      return [
        `${p.key}: ${p.summary ?? ""}`,
        `  ${join(p.shape, `default ${prefText(p.default)}`, who)}`,
      ];
    }
    return [`${p.key} = ${prefText(p.value)}${p.is_default === true ? " (default)" : ""} · ${who}`];
  };
  const changed = (result.changed ?? []).map((c) => [
    `${c.key}: ${prefText(c.from)} -> ${prefText(c.to)}`,
  ]);
  return {
    parts: [
      fixed(
        `${join(
          result.result,
          result.proposal !== undefined && `proposal ${result.proposal}`,
          `${String(result.prefs.length)} key${result.prefs.length === 1 ? "" : "s"}`,
        )} · as_of ${result.as_of}${replayed(result)}`,
      ),
      { data: true, units: [...changed, ...result.prefs.map(row)] },
    ],
    more: "Ask for fewer keys.",
  };
}

// ---------------------------------------------------------------------------------------------
// The renderers, by entry

type Renderer = (
  result: never,
  tools: { readonly getTask: string; readonly tool: string },
) => Rendered & { max?: number };

const RENDERERS: Readonly<Record<string, Renderer>> = {
  "space.status": (result: Status) => ({
    parts: statusParts(result),
    more: STATUS_MORE,
    ...(result.guide === undefined ? {} : { max: GUIDE_TOKENS }),
  }),
  "task.get": (result: TaskGet, { getTask }) => {
    if (result.view === "status") {
      return { parts: statusParts(result, result.bound), more: STATUS_MORE };
    }
    if (result.view === "digest") return { ...digestRendered(result, getTask), max: DIGEST_TOKENS };
    return sectionsRendered(result, getTask);
  },
  "task.update": (result: OutputOf<"task.update">) => {
    const fields = result.fields.length === 0 ? "" : `: ${result.fields.join(", ")}`;
    const head =
      result.result === "updated"
        ? `updated ${result.task}${fields}`
        : result.result === "no_change"
          ? `no change ${result.task}`
          : result.result === "review"
            ? `review ${result.task}${fields} (applied, marked for the user's review)`
            : `proposed ${result.task}${fields}${result.proposal === undefined ? "" : ` · proposal ${result.proposal}`}`;
    return {
      parts: [
        fixed(
          `${head} · as_of ${result.as_of}${replayed(result)}`,
          ...result.warnings.map((w) => `warning: ${w}`),
        ),
      ],
      more: "",
    };
  },
  "entry.add": (result: OutputOf<"entry.add">) => ({
    parts: [
      fixed(
        `${result.kind === "note" ? `noted ${result.entry}` : `logged ${result.entry}`} on ${result.task}${result.kind === "note" ? "" : ` (${result.kind})`} · as_of ${result.as_of}${replayed(result)}`,
      ),
    ],
    more: "",
  }),
  "task.finish": (result: OutputOf<"task.finish">, { getTask }) => {
    const head =
      result.result === "completed"
        ? join(
            `completed ${result.task}`,
            result.lifecycle !== "completed" && result.lifecycle,
            result.wrap_state,
            `${String(result.learnings)} learning${result.learnings === 1 ? "" : "s"}`,
          )
        : result.result === "no_change"
          ? `no change ${result.task} (already ${result.lifecycle})`
          : result.result === "review"
            ? `review ${result.task} · waiting for the user's check-off`
            : join(
                `proposed ${result.task}`,
                result.proposal !== undefined && `proposal ${result.proposal}`,
              );
    // Every follow-up by its input path, never cut, without the caller's own title (A3 3.2.5).
    return {
      parts: [
        fixed(
          `${head} · as_of ${result.as_of}${replayed(result)}`,
          ...result.follow_ups.map(
            (f, k) =>
              `follow_ups.${String(k)}: ${f.result}${f.ref === undefined ? "" : ` ${f.ref}`}`,
          ),
        ),
      ],
      more: `Read them with ${getTask}.`,
    };
  },
  "task.search": (result: Search, { tool }) => searchRendered(result, tool),
  "task.add": (result: OutputOf<"task.add">) => addRendered(result),
  "task.reopen": (result: OutputOf<"task.reopen">) => {
    const head =
      result.result === "reopened"
        ? `reopened ${result.task}`
        : result.result === "no_change"
          ? `no change ${result.task} (already ${result.lifecycle})`
          : join(
              `proposed ${result.task}`,
              result.proposal !== undefined && `proposal ${result.proposal}`,
            );
    return {
      parts: [
        fixed(`${head} · as_of ${result.as_of}${replayed(result)}`),
        // A status is a key of the space's own list (A1 3.16), which a person or an agent wrote.
        ...(result.result === "reopened"
          ? [{ data: true, fixed: true, units: [[`Status: ${result.status}`]] }]
          : []),
      ],
      more: "",
    };
  },
  "group.manage": (result: Groups, { tool }) => groupsRendered(result, tool),
  "prefs.manage": (result: Prefs) => prefsRendered(result),
  "run.report": (result: OutputOf<"run.report">) => ({
    parts: [
      fixed(
        `reported on run ${result.run} · ${String(result.sources)} source${result.sources === 1 ? "" : "s"} · as_of ${result.as_of}${replayed(result)}`,
      ),
    ],
    more: "",
  }),
};

/** Whether `entryName` has a compact rendering. Every MCP tool has one (render.test.ts). */
export const hasRenderer = (entryName: string): boolean => Object.hasOwn(RENDERERS, entryName);

/** An entry's result as its compact text, within the entry's result budget (A3 3.2.5). */
export function renderResult(entryName: string, result: unknown, random?: Random): string {
  const renderer = RENDERERS[entryName];
  const entry = findEntry(entryName);
  const max = entry?.budget?.max ?? LIMITS.result;
  if (renderer === undefined) {
    // No tool without a renderer is listed; a later entry gets one with its tool.
    return fit(
      { parts: [fixed("ok"), { data: true, units: [[JSON.stringify(result)]] }], more: "" },
      max,
      random,
    );
  }
  const rendered = (
    renderer as (r: unknown, t: { getTask: string; tool: string }) => Rendered & { max?: number }
  )(result, { getTask: toolOf("task.get"), tool: entry?.faces.mcp?.tool ?? entryName });
  return fit(rendered, Math.min(max, rendered.max ?? max, LIMITS.result), random);
}

// ---------------------------------------------------------------------------------------------
// Errors (A3 3.5): `error <code> (<reason>): <one sentence>. <hint>`, then the issues, then the
// current values of a conflict and any candidate rows inside a data block.

const WORD = /^[a-z][a-z_]{0,39}$/;

interface Conflict {
  readonly task?: unknown;
  readonly field?: unknown;
  readonly value?: unknown;
  readonly version?: unknown;
  readonly by?: unknown;
  readonly at?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);

/** An error body as the text a tool result carries, within A3's error budget. */
export function renderError(body: ErrorBody, random?: Random): string {
  const data = body.data ?? {};
  const reason =
    typeof data["reason"] === "string" && WORD.test(data["reason"]) ? ` (${data["reason"]})` : "";
  const issues = Array.isArray(data["issues"])
    ? (data["issues"] as { path?: unknown; message?: unknown }[])
    : [];
  const conflicts = Array.isArray(data["conflicts"]) ? (data["conflicts"] as Conflict[]) : [];
  const candidates = Array.isArray(data["candidates"]) ? (data["candidates"] as RowLike[]) : [];
  // Which fields conflict and their versions are structured values: they stay whole. Their
  // current values and who wrote them (an actor's label can be a name someone chose) are inside
  // the block, the first to be cut.
  const where = (c: Conflict) => join(asText(c.task), asText(c.field)).replaceAll(" · ", " ");
  const parts: Part[] = [
    fixed(
      `error ${body.code}${reason}: ${messageWithHint(body.message, body.hint, CLI_NAME)}${data["replayed"] === true ? " (replayed)" : ""}`,
      ...issues
        .slice(0, 5)
        .map(
          (issue) =>
            `- ${asText(issue.path) === "" ? "input" : asText(issue.path)}: ${asText(issue.message)}`,
        ),
      conflicts.length === 0
        ? undefined
        : // A wrap-up held whatever the base (A3 3.4.8) did not change since it.
          `${data["reason"] === "already_wrapped" ? "Wrapped up already" : "Changed since your base"}: ${conflicts
            .slice(0, 5)
            .map((c) => `${where(c)} (v${asText(c.version)})`)
            .join(", ")}`,
      typeof data["as_of"] === "string" ? `as_of ${data["as_of"]}` : undefined,
    ),
  ];
  if (conflicts.length > 0) {
    parts.push({
      data: true,
      title: (kept, total) => `Current values (${String(kept)} of ${String(total)})`,
      units: conflicts
        .slice(0, 5)
        .map((c) => [
          `- ${where(c)} = ${c.value === undefined ? "(none)" : JSON.stringify(clip(asText(c.value), 60))} by ${asText(c.by)}`,
        ]),
    });
  }
  if (candidates.length > 0) {
    parts.push({
      data: true,
      title: () => "Candidates",
      units: candidates.slice(0, 3).map((row) => [`- ${rowLine(row)}`]),
    });
  }
  // Close names from the space (A3 3.5: stored values only in data.suggestions), as data.
  const suggestions = Array.isArray(data["suggestions"])
    ? (data["suggestions"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (suggestions.length > 0) {
    parts.push({
      data: true,
      title: () => "Did you mean",
      units: suggestions.slice(0, 5).map((s) => [`- ${clip(s, 120)}`]),
    });
  }
  return fit({ parts, more: "Read the task again for the rest." }, ERROR_TOKENS, random);
}
