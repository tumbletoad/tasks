// Whether a home's TTasks tools start, and what a person can do about it from where they are: one
// answer from the facts of the home. Settings, the first start, `ttasks setup agents` (status,
// preview and apply) and doctor read it, and apply carries out only what it offers, so what a row
// says, what it offers and what Apply does are one thing.

/** Why setup leaves a home alone: its file is in a state setup does not understand. */
export type Refusal =
  | "unreadable"
  | "too_large"
  | "encoding"
  | "invalid_file"
  | "duplicate_key"
  | "managed"
  | "wrong_type"
  | "unsupported_layout"
  | "foreign_entry"
  /** Linux and macOS: the file or its folder belongs to another user, or anyone can change it. */
  | "unsafe"
  /** Claude Desktop's file is not there yet: the app makes it in its developer settings. */
  | "not_set_up"
  /** Several Claude Desktop configuration files: `--home` names the one the app uses. */
  | "ambiguous"
  /**
   * Setup's own record cannot be read: a home's access can still be turned off, and no file, the
   * record included, is changed until it can be read.
   */
  | "record_unreadable";

export type HomeState =
  /** No entry of TTasks's name, and setup can add one. */
  | "not_registered"
  /** The entry is exactly the one setup wrote. */
  | "registered"
  /** The entry setup wrote was changed since: setup leaves it alone. */
  | "edited"
  /** Setup wrote an entry that is gone now. */
  | "missing"
  /** A setup that did not finish (a crash, a failed undo): the next setup settles it first. */
  | "interrupted"
  | "refused";

/** What one settings file of a home holds of setup's, judged against the home's record. */
export type FileState =
  /** No entry of TTasks's name, and the record names no entry of setup's here. */
  | "absent"
  /** Exactly the entry setup wrote here. */
  | "own"
  /** The entry setup wrote here, changed since: the person's now. */
  | "edited"
  /** Setup wrote an entry here that is gone. */
  | "gone"
  /** An entry of TTasks's name that setup did not write here. */
  | "foreign"
  /** A file setup does not understand (`refusal`). */
  | "refused";

/** The facts of one settings file of a home. */
export interface FileFacts {
  readonly file: string;
  readonly state: FileState;
  readonly refusal?: Refusal;
  /**
   * Whether the program the file's entry names is there: `moved` when setup's own entry names where
   * TTasks was installed before, `gone` when it names the install that is missing now or any other
   * program that is not there. Undefined without an entry.
   */
  readonly program?: "there" | "moved" | "gone";
  /** A new entry can go into the file (agents.ts `planChange`), or why it cannot. */
  readonly writable: true | Refusal;
  /** An entry added by hand that names no instance: it reaches the machine's default space. */
  readonly handMade: boolean;
}

/** The facts of one home, read once for one answer (agents.ts `toolsOf`). */
export interface ToolsFacts {
  /** What setup found in the home's files, judged against its record (agents.ts `inspectHome`). */
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** Each of the home's settings files, in its order: one, or two for Claude Code's default folder. */
  readonly files: readonly FileFacts[];
  /** The home's agent-home row: live, off, or unknown (no service answered). */
  readonly access: "live" | "off" | "unknown";
  /** The record, or the home's live row without one, names another space than the one the person is in. */
  readonly otherSpace: boolean;
  /** TTasks's command is installed where a new entry runs it. */
  readonly installed: boolean;
  /**
   * Whether the program the record's entry names is there, as `program` says it of a file's: what
   * a file of the home that lacks the entry gets is that entry while it runs. Undefined without a
   * record.
   */
  readonly recorded?: "there" | "moved" | "gone";
}

/** The one reason a row gives: why the tools do not start, why it cannot be turned on, or what to know. */
export type ToolsWhy =
  | Refusal
  | "missing"
  | "moved"
  | "not_installed"
  | "edited"
  | "edited_gone"
  | "access_off"
  | "other_space"
  | "interrupted"
  | "entry_left"
  /** One of the home's files has no entry of setup's: a reader of that file gets no tools. */
  | "file_lacks";

/**
 * What turning the tools on does: a new entry (also into a file that lacks the one its home has),
 * its access again, or its entry written again with the command installed now, in each file.
 */
export type TurnOn = "add" | "grant" | "repair";

/** A reason that is about one file of a home with several. */
export interface FileWhy {
  readonly why: ToolsWhy;
  readonly file: string;
}

export interface ToolsAnswer {
  /** `on`: the tools start. `unknown`: they would, and no service said whether the access is live. */
  readonly status: "on" | "off" | "unknown";
  readonly why?: ToolsWhy;
  /** The file `why` is about, in a home with several files. */
  readonly file?: string;
  /** The reasons of the home's other files, each file once and never `file`: a home with several. */
  readonly more?: readonly FileWhy[];
  /** Turning on, when it can be done from here: also while the tools start, for a file they do not. */
  readonly on?: TurnOn;
  /** Turning off can be done: the access is live or could not be confirmed off. */
  readonly off: boolean;
}

/**
 * The answer for one home. Turning off is offered whenever the access may be live, whatever else is
 * missing; turning on only when apply will do it from here. The reason says what stops the tools,
 * or, when turning on is not offered for another cause (another space, a file that takes no entry,
 * no install), that cause.
 *
 * A home with several files that setup set up answers from all of them (byFile): its tools start
 * while its access is live and one of its files holds an entry that runs, and each file that does
 * not is named with why. Before setup set it up, while a setup did not finish, and while its record
 * cannot be read, the home answers as one of its files (leadOf) would, and names the others'.
 */
export function toolsAnswer(f: ToolsFacts): ToolsAnswer {
  const lead = leadOf(f);
  if (f.files.length === 1) return oneFile(f, lead, lead.writable);
  if (
    f.state === "registered" ||
    f.state === "edited" ||
    f.state === "missing" ||
    (f.state === "refused" && f.refusal !== "foreign_entry" && f.refusal !== "record_unreadable")
  ) {
    return byFile(f);
  }
  const writable = f.files.some((x) => x.writable === true) ? true : lead.writable;
  const base = oneFile(f, lead, writable);
  const others = f.files.flatMap((x): FileWhy[] => {
    if (x === lead) return [];
    if (x.state === "refused") return [{ why: x.refusal ?? "unreadable", file: x.file }];
    return x.state === "foreign" ? [{ why: "foreign_entry", file: x.file }] : [];
  });
  const about = base.why !== undefined && FILE_WHYS.has(base.why) ? lead.file : undefined;
  return named(base, about, others);
}

/**
 * `base` with its reasons placed: `file` for its own when that is about a file, else the first of
 * `more` when it has none, and the rest after it.
 */
function named(base: ToolsAnswer, file: string | undefined, more: readonly FileWhy[]): ToolsAnswer {
  const [first, ...rest] = more;
  const lead =
    base.why === undefined && first !== undefined
      ? { why: first.why, file: first.file, rest }
      : { why: base.why, file, rest: more };
  return {
    status: base.status,
    ...(lead.why === undefined ? {} : { why: lead.why }),
    ...(lead.file === undefined ? {} : { file: lead.file }),
    ...(lead.rest.length === 0 ? {} : { more: lead.rest }),
    ...(base.on === undefined ? {} : { on: base.on }),
    off: base.off,
  };
}

/** The reasons that are about one file of a home rather than the home. */
const FILE_WHYS = new Set<ToolsWhy>([
  "unreadable",
  "too_large",
  "encoding",
  "invalid_file",
  "duplicate_key",
  "managed",
  "wrong_type",
  "unsupported_layout",
  "foreign_entry",
  "unsafe",
  "edited",
  "edited_gone",
  "file_lacks",
]);

/**
 * The answer of a home setup set up, from each of its files. A file holds an entry that runs when
 * it holds setup's, the person's or another's whose program is there; one setup cannot read holds
 * none it can tell of. Turning on writes the entry again with the command installed now wherever
 * setup's own runs a program that moved, or into a file that lacks it while the recorded one does
 * not run (repair); else the recorded entry into each file that lacks it (add); else gives the
 * access again. Each is offered only from the home's space, with its access known.
 */
function byFile(f: ToolsFacts): ToolsAnswer {
  const off = f.access !== "off";
  const live = f.access === "live" ? "on" : f.access === "unknown" ? "unknown" : "off";
  const runs = (x: FileFacts) =>
    (x.state === "own" || x.state === "edited" || x.state === "foreign") &&
    x.program !== "moved" &&
    x.program !== "gone";
  const running = f.files.filter(runs);
  const lacking = f.files.filter((x) => x.state === "gone" || x.state === "absent");
  const writing = lacking.filter((x) => x.writable === true);
  const moved = f.files.some((x) => x.state === "own" && x.program === "moved");
  const anyEntry = f.files.some((x) => x.state === "own" || x.state === "edited");
  const handMade = running.some((x) => x.state === "foreign" && x.handMade);
  const status = running.length === 0 ? "off" : handMade ? "on" : live;

  const wanted: TurnOn | undefined =
    moved || (writing.length > 0 && (f.recorded === "moved" || !anyEntry))
      ? "repair"
      : writing.length > 0 && f.recorded === "there"
        ? "add"
        : f.access === "off" && running.some((x) => x.state === "own")
          ? "grant"
          : undefined;
  /** What keeps `wanted` from being offered here. */
  const stop: ToolsWhy | undefined =
    wanted === undefined
      ? undefined
      : f.otherSpace
        ? "other_space"
        : wanted === "repair" && !f.installed
          ? "not_installed"
          : undefined;
  const on =
    wanted !== undefined && stop === undefined && f.access !== "unknown" ? wanted : undefined;

  // Each file that does not hold an entry that runs, or holds one the person changed, with why.
  const whys = f.files.flatMap((x): FileWhy[] => {
    const why = fileWhy(x, f.installed);
    return why === undefined ? [] : [{ why, file: x.file }];
  });
  // The home's own reason, said before any file's when no file says it already. Its access being
  // off is the reason only where turning on gives it again.
  const home: ToolsWhy | undefined =
    stop !== undefined && !whys.some((w) => w.why === stop)
      ? stop
      : f.otherSpace && status !== "off"
        ? "other_space"
        : running.length > 0 && f.access === "off" && on !== undefined
          ? "access_off"
          : !anyEntry && running.length === 0 && lacking.length > 0
            ? "missing"
            : undefined;
  // Nothing of setup's left anywhere is said once, for the home.
  const more = home === "missing" ? whys.filter((w) => w.why !== "file_lacks") : whys;
  const base: ToolsAnswer = {
    status,
    ...(home === undefined ? {} : { why: home }),
    ...(on === undefined ? {} : { on }),
    off,
  };
  return named(base, undefined, more);
}

/** What one file of a home setup set up says, beside the others: undefined while it is setup's and runs. */
export function fileWhy(x: FileFacts, installed: boolean): ToolsWhy | undefined {
  switch (x.state) {
    case "refused":
      return x.refusal ?? "unreadable";
    case "foreign":
      return "foreign_entry";
    case "edited":
      return x.program === "moved" || x.program === "gone" ? "edited_gone" : "edited";
    case "own":
      if (x.program === "moved") return installed ? "moved" : "not_installed";
      return x.program === "gone" ? "not_installed" : undefined;
    case "gone":
    case "absent":
      return "file_lacks";
  }
}

/**
 * The file a home's state comes from (agents.ts `homeState`): the one with an entry setup did not
 * write, the first with setup's own entry, the first changed by hand, the first whose entry is
 * gone, the first setup can read; else the first.
 */
function leadOf(f: ToolsFacts): FileFacts {
  const first = (...states: FileState[]) => f.files.find((x) => states.includes(x.state));
  const [head] = f.files;
  if (head === undefined) throw new Error("A home has at least one settings file");
  const lead =
    f.state === "refused" && f.refusal === "foreign_entry"
      ? first("foreign")
      : f.state === "registered"
        ? first("own")
        : f.state === "edited"
          ? first("edited")
          : f.state === "missing"
            ? first("gone")
            : f.state === "interrupted"
              ? first("own", "edited", "foreign")
              : f.state === "not_registered"
                ? first("absent")
                : undefined;
  return lead ?? head;
}

/** The answer of a home of one file, `lead`, with the home's facts. */
function oneFile(f: ToolsFacts, lead: FileFacts, writable: true | Refusal): ToolsAnswer {
  const entry = lead.state === "own" || lead.state === "edited" || lead.state === "foreign";
  const off = f.access !== "off";
  const live = f.access === "live" ? "on" : f.access === "unknown" ? "unknown" : "off";
  const made = (
    status: ToolsAnswer["status"],
    why: ToolsWhy | undefined,
    on?: TurnOn,
  ): ToolsAnswer => ({
    status,
    ...(why === undefined ? {} : { why }),
    ...(on === undefined || status === "on" ? {} : { on }),
    off,
  });
  /** What keeps a new entry out of the file, when turning on needs one. */
  const blocked = writable !== true ? writable : f.installed ? undefined : "not_installed";
  /**
   * Turning on `on` here: offered, or the cause that keeps it from being offered. Writing a
   * registered home's entry again renews its access, which needs the access known.
   */
  const offer = (on: TurnOn, stop: ToolsWhy | undefined): ToolsAnswer => {
    const status = stop === undefined ? live : "off";
    if (f.otherSpace) return made(status, "other_space");
    if (on === "grant") return made(status, stop, on);
    if (f.access === "unknown") return made(status, stop);
    return blocked === undefined ? made(status, stop, on) : made(status, blocked);
  };
  const program = entry ? lead.program : undefined;
  switch (f.state) {
    case "refused":
      if (f.refusal === "foreign_entry") return made(lead.handMade ? "on" : live, "foreign_entry");
      // No file at all: no entry to start (Claude Desktop's file is made by the app).
      if (f.refusal === "not_set_up") return made("off", "not_set_up");
      return made(live, f.refusal ?? "unreadable");
    case "not_registered": {
      // A live row with no entry (setup's record was lost): its entry is what is missing. Its
      // space is the home's: an apply from another one would move the access there.
      if (f.access === "live" && f.otherSpace) return made("off", "other_space");
      const lost = f.access === "live" ? "missing" : undefined;
      return blocked === undefined ? made("off", lost, "add") : made("off", lost ?? blocked);
    }
    case "interrupted": {
      // The next apply finishes it first as a removal, then this one adds; not from another
      // space while the record's access may be live.
      const why = entry && !off ? "entry_left" : "interrupted";
      const status = entry && program !== "moved" && program !== "gone" ? live : "off";
      if (off && f.otherSpace) return made(status, "other_space");
      return blocked === undefined ? made(status, why, "add") : made(status, why);
    }
    case "missing":
      return offer("repair", "missing");
    case "edited":
      // The person's entry is never written over: turning it off is all setup does there.
      if (program === "moved" || program === "gone") return made("off", "edited_gone");
      return made(f.access === "off" ? "off" : live, "edited");
    case "registered":
      if (program === "moved") return offer("repair", "moved");
      if (program === "gone") return made("off", "not_installed");
      if (f.access === "off") return offer("grant", "access_off");
      return made(live, f.otherSpace ? "other_space" : undefined);
  }
}
