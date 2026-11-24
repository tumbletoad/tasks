// Whether a home's TTasks tools start, and what a person can do about it from where they are: one
// answer for each of the home's settings files from that file's facts, and the home's answer from
// those. Settings, the first start, `ttasks setup agents` (status, preview and apply) and doctor read
// it, and apply carries out only what it offers, so what a row says, what it offers and what Apply
// does are one thing.

/** Why setup leaves a file alone: it is in a state setup does not understand. */
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
  /** The app has not made this file: Claude Desktop's, or a settings file setup never creates. */
  | "not_set_up"
  /** Several Claude Desktop configuration files: `--home` names the one the app uses. */
  | "ambiguous"
  /** The file is read-only: a new entry cannot go into it. */
  | "read_only"
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

/** The facts of one settings file of a home, read once for one answer (agents.ts `toolsOf`). */
export interface ToolsFacts {
  /** What setup found in the file, judged against its record (agents.ts `inspectHome`). */
  readonly state: HomeState;
  readonly refusal?: Refusal;
  /** An entry of TTasks's name is in the file. */
  readonly entry: boolean;
  /**
   * The program the entry runs: `there`; `older`, setup's own entry running an install that is
   * there but is not this one; `moved`, setup's own entry naming where TTasks was installed before;
   * `gone`. Undefined without an entry, or for an entry that names no program.
   */
  readonly program?: "there" | "older" | "moved" | "gone";
  /** The entry names the home's instance and space, so the home's access reaches it. */
  readonly binds: boolean;
  /** The home's agent-home row: live, off, or unknown (no service answered). */
  readonly access: "live" | "off" | "unknown";
  /** The home is set up for another space than the one the person is in. */
  readonly otherSpace: boolean;
  /** A new entry can go into the file (agents.ts `planChange`), or why it cannot. */
  readonly writable: true | Refusal;
  /** TTasks's command is installed where a new entry runs it. */
  readonly installed: boolean;
  /** An entry added by hand that names no instance: it reaches the machine's default space. */
  readonly handMade: boolean;
  /** Setup's record holds an entry of its own in the file, which turning off takes out. */
  readonly owned: boolean;
}

/** The one reason a file gives: why the tools do not start, why it cannot be turned on, or what to know. */
export type ToolsWhy =
  | Refusal
  | "missing"
  | "moved"
  | "older"
  | "not_installed"
  | "no_program"
  | "unbound"
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
  /**
   * Turning on, when it can be done from here; with the tools on, the repair that writes the entry
   * with this install's command.
   */
  readonly on?: TurnOn;
  /** Turning off can be done: the access may be live, or an entry of setup's is still there. */
  readonly off: boolean;
}

/**
 * The answer for one file. Turning off is offered whenever the access may be live, or setup's own
 * entry is still there, whatever else is missing; turning on only when apply will do it from here,
 * and never while no service said whether the access is live. The tools are on only when the entry
 * will start: its program is there, and it names the home's instance and space.
 */
export function toolsAnswer(f: ToolsFacts): ToolsAnswer {
  const off = f.access !== "off" || f.owned;
  const live = f.access === "live" ? "on" : f.access === "unknown" ? "unknown" : "off";
  const made = (
    status: ToolsAnswer["status"],
    why: ToolsWhy | undefined,
    on?: TurnOn,
  ): ToolsAnswer => ({
    status,
    ...(why === undefined ? {} : { why }),
    // With the tools on, turning on is only the repair to this install's command.
    ...(on === undefined || f.access === "unknown" || (status === "on" && on !== "repair")
      ? {}
      : { on }),
    off,
  });
  /** What keeps a new entry out of the file, when turning on needs one. */
  const blocked = f.writable !== true ? f.writable : f.installed ? undefined : "not_installed";
  /** Turning on `on` here: offered, or the cause that keeps it from being offered. */
  const offer = (on: TurnOn, stop: ToolsWhy): ToolsAnswer => {
    if (f.otherSpace) return made("off", "other_space");
    if (on === "grant") return made("off", stop, on);
    return blocked === undefined ? made("off", stop, on) : made("off", blocked);
  };
  const program = f.entry ? f.program : undefined;
  const starts = (program === "there" || program === "older") && f.binds;
  switch (f.state) {
    case "refused":
      if (f.refusal === "foreign_entry") {
        if (program === undefined) return made("off", "no_program");
        // A hand-made entry reaches the default space by its own rule, with or without access.
        if (f.handMade) return made(program === "there" ? "on" : "off", "foreign_entry");
        return made(starts ? live : "off", "foreign_entry");
      }
      // Setup cannot read the file, so it cannot say that the tools start.
      return made("off", f.refusal ?? "unreadable");
    case "not_registered": {
      // A live row with no entry here (setup's record was lost, or another file has it): this
      // file's entry is what is missing, unless it cannot take one.
      if (f.otherSpace) return made("off", "other_space");
      const lost = f.access === "live" ? "missing" : undefined;
      return blocked === undefined ? made("off", lost, "add") : made("off", blocked);
    }
    case "interrupted": {
      // The next apply finishes it first as a removal, then this one adds.
      const why = f.entry && f.access === "off" ? "entry_left" : "interrupted";
      const status = f.entry && starts ? live : "off";
      if (f.otherSpace) return made(status, "other_space");
      return blocked === undefined ? made(status, why, "add") : made(status, why);
    }
    case "missing":
      return offer("repair", "missing");
    case "edited":
      // The person's entry is never written over: turning it off is all setup does there.
      if (program === undefined) return made("off", "no_program");
      if (program === "moved" || program === "gone") return made("off", "edited_gone");
      if (!f.binds) return made("off", "unbound");
      return made(live, "edited");
    case "registered":
      // Its record names another space or instance than the home's access: turning off cleans it.
      if (!f.binds) return made("off", "unbound");
      if (program === "moved") return offer("repair", "moved");
      if (program === "gone") return made("off", "not_installed");
      if (f.access === "off") return offer("grant", "access_off");
      if (f.otherSpace) return made(live, "other_space");
      if (program === "older") {
        return made(live, "older", blocked === undefined ? "repair" : undefined);
      }
      return made(live, undefined);
  }
}

/** One settings file of a home that needs something: its own reason, and what turning on does there. */
export interface FileNeed {
  readonly file: string;
  readonly why?: ToolsWhy;
  readonly on?: TurnOn;
}

/** A home's answer, from the answers of its settings files. */
export interface HomeAnswer {
  /** `on` when a file's tools start; `unknown` when one's would and the access is not known. */
  readonly status: "on" | "off" | "unknown";
  /** Each file with a reason or something to turn on, in the home's order. */
  readonly files: readonly FileNeed[];
  /** Turning the home off can be done: some file offers it. */
  readonly off: boolean;
}

/** The home's answer: on as soon as one file's tools start, and each file's need said as its own. */
export function homeAnswer(
  files: readonly { readonly file: string; readonly answer: ToolsAnswer }[],
): HomeAnswer {
  const has = (status: ToolsAnswer["status"]) => files.some((f) => f.answer.status === status);
  return {
    status: has("on") ? "on" : has("unknown") ? "unknown" : "off",
    files: files.flatMap(({ file, answer }) =>
      answer.why === undefined && answer.on === undefined
        ? []
        : [
            {
              file,
              ...(answer.why === undefined ? {} : { why: answer.why }),
              ...(answer.on === undefined ? {} : { on: answer.on }),
            },
          ],
    ),
    off: files.some((f) => f.answer.off),
  };
}
