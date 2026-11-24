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

/** The facts of one home, read once for one answer (agents.ts `toolsOf`). */
export interface ToolsFacts {
  /** What setup found in the home's file, judged against its record (agents.ts `inspectHome`). */
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** An entry of TTasks's name is in the file. */
  readonly entry: boolean;
  /**
   * Whether the program the entry names is there: `moved` when it named where TTasks was installed
   * before, `gone` when it names the install that is missing now or any other program that is
   * not there. Undefined without an entry.
   */
  readonly program?: "there" | "moved" | "gone";
  /** The home's agent-home row: live, off, or unknown (no service answered). */
  readonly access: "live" | "off" | "unknown";
  /** The record names another space than the one the person is in. */
  readonly otherSpace: boolean;
  /** A new entry can go into the file (agents.ts `planChange`), or why it cannot. */
  readonly writable: true | Refusal;
  /** TTasks's command is installed where a new entry runs it. */
  readonly installed: boolean;
  /** An entry added by hand that names no instance: it reaches the machine's default space. */
  readonly handMade: boolean;
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
  | "entry_left";

/** What turning the tools on does: a new entry, its access again, or its entry written again. */
export type TurnOn = "add" | "grant" | "repair";

export interface ToolsAnswer {
  /** `on`: the tools start. `unknown`: they would, and no service said whether the access is live. */
  readonly status: "on" | "off" | "unknown";
  readonly why?: ToolsWhy;
  /** Turning on, when it can be done from here. */
  readonly on?: TurnOn;
  /** Turning off can be done: the access is live or could not be confirmed off. */
  readonly off: boolean;
}

/**
 * The answer for one home. Turning off is offered whenever the access may be live, whatever else is
 * missing; turning on only when apply will do it from here. The reason says what stops the tools,
 * or, when turning on is not offered for another cause (another space, a file that takes no entry,
 * no install), that cause.
 */
export function toolsAnswer(f: ToolsFacts): ToolsAnswer {
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
  const blocked = f.writable !== true ? f.writable : f.installed ? undefined : "not_installed";
  /** Turning on `on` here: offered, or the cause that keeps it from being offered. */
  const offer = (on: TurnOn, stop: ToolsWhy | undefined): ToolsAnswer => {
    const status = stop === undefined ? live : "off";
    if (f.otherSpace) return made(status, "other_space");
    if (on === "grant") return made(status, stop, on);
    return blocked === undefined ? made(status, stop, on) : made(status, blocked);
  };
  const program = f.entry ? f.program : undefined;
  switch (f.state) {
    case "refused":
      if (f.refusal === "foreign_entry") return made(f.handMade ? "on" : live, "foreign_entry");
      // No file at all: no entry to start (Claude Desktop's file is made by the app).
      if (f.refusal === "not_set_up") return made("off", "not_set_up");
      return made(live, f.refusal ?? "unreadable");
    case "not_registered": {
      // A live row with no entry (setup's record was lost): its entry is what is missing.
      const lost = f.access === "live" ? "missing" : undefined;
      return blocked === undefined ? made("off", lost, "add") : made("off", lost ?? blocked);
    }
    case "interrupted": {
      // The next apply finishes it first as a removal, then this one adds.
      const why = f.entry && !off ? "entry_left" : "interrupted";
      const status = f.entry && program !== "moved" && program !== "gone" ? live : "off";
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
