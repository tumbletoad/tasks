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
  /** One of the home's files has no entry of setup's while another has: a reader of that file gets no tools. */
  | "file_lacks";

/**
 * What turning the tools on does: a new entry (into each file that has none, also beside a file
 * that has it), its access again, or its entry written again.
 */
export type TurnOn = "add" | "grant" | "repair";

export interface ToolsAnswer {
  /** `on`: the tools start. `unknown`: they would, and no service said whether the access is live. */
  readonly status: "on" | "off" | "unknown";
  readonly why?: ToolsWhy;
  /** The file `why` is about, in a home with several files. */
  readonly file?: string;
  /** Turning on, when it can be done from here: also while the tools start, when a file lacks the entry. */
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
 * A home with several files answers from the file its state comes from (leadOf), as a home of that
 * one file would; while the tools start there, the reason is the first other file's that does not
 * hold setup's entry, with that file, and a file with no entry yet is one turning on writes.
 */
export function toolsAnswer(f: ToolsFacts): ToolsAnswer {
  const lead = leadOf(f);
  const writable = f.files.some((x) => x.writable === true) ? true : lead.writable;
  const base = oneFile(f, lead, writable);
  if (f.files.length === 1) return base;
  const said = base.why === undefined ? undefined : { why: base.why, file: lead.file };
  const others = f.files.flatMap((x) => {
    const why = x === lead ? undefined : otherWhy(f.state, x);
    return why === undefined ? [] : [{ x, why }];
  });
  const [other] = others;
  // Writing a home's entries again takes setup's out first, and an entry the person changed or
  // added in another file would then refuse the new one: that file is what to know.
  const stuck =
    base.on === "repair"
      ? others.find((o) => o.x.state === "edited" || o.x.state === "foreign")
      : undefined;
  const why =
    stuck !== undefined
      ? { why: stuck.why, file: stuck.x.file }
      : (said ?? (other === undefined ? undefined : { why: other.why, file: other.x.file }));
  const fileLevel = why !== undefined && (why !== said || FILE_WHYS.has(why.why));
  // A file that lacks the entry beside one that has it: turning on writes it, and gives the
  // access when it is off. Not from another space, and not without a read of the access.
  const completes =
    f.state === "registered" &&
    other?.why === "file_lacks" &&
    other.x.writable === true &&
    f.installed &&
    !f.otherSpace &&
    f.access !== "unknown" &&
    (base.on === undefined || base.on === "grant") &&
    (base.status !== "off" || base.why === "access_off");
  const on = completes ? "add" : stuck === undefined ? base.on : undefined;
  return {
    status: base.status,
    ...(why === undefined ? {} : { why: why.why }),
    ...(why !== undefined && fileLevel ? { file: why.file } : {}),
    ...(on === undefined ? {} : { on }),
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

/** What another file of a registered or edited home says, beside the file its state comes from. */
function otherWhy(state: HomeState, x: FileFacts): ToolsWhy | undefined {
  if (x.state === "refused") return x.refusal ?? "unreadable";
  if (x.state === "foreign") return "foreign_entry";
  if (x.state === "edited")
    return x.program === "moved" || x.program === "gone" ? "edited_gone" : "edited";
  if (x.state === "own") return undefined;
  return state === "registered" || state === "edited" ? "file_lacks" : undefined;
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
  /** Turning on `on` here: offered, or the cause that keeps it from being offered. */
  const offer = (on: TurnOn, stop: ToolsWhy | undefined): ToolsAnswer => {
    const status = stop === undefined ? live : "off";
    if (f.otherSpace) return made(status, "other_space");
    if (on === "grant") return made(status, stop, on);
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
