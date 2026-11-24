// Run process groups: the processes of one background run, ended together and confirmed empty where
// a process group can hold them, and ended as far as TTasks can find them where none can.
import { LinuxProcessGroups, type LinuxOptions } from "./linux.ts";
import { unavailableMessage } from "./placement.ts";
import {
  type ConfirmOptions,
  type ProcessGroupKind,
  type Confirmation,
  type StartedAgent,
  type ProcessGroups,
  type ProcessGroupSpec,
  type ProbeResult,
} from "./types.ts";
import { UngroupedProcesses, type UngroupedOptions } from "./ungrouped.ts";
import { WindowsProcessGroups } from "./windows.ts";

export * from "./types.ts";
export { windowsCommandLine, quoteWindowsArg } from "./command-line.ts";
export { JOIN_FAILED_EXIT, LinuxProcessGroups, type LinuxOptions } from "./linux.ts";
export { MAIN_CGROUP, placement, RUN_HELPER, unavailableMessage } from "./placement.ts";
export { descendants, UngroupedProcesses, type UngroupedOptions } from "./ungrouped.ts";
export { jobName, WindowsProcessGroups, type WindowsOptions } from "./windows.ts";

export interface ProcessGroupsOptions {
  readonly platform?: NodeJS.Platform;
  /** Windows: the absolute path of ttasks-run.exe. */
  readonly runHelper?: string;
  readonly linux?: LinuxOptions;
  readonly ungrouped?: UngroupedOptions;
}

/** Where no process group exists at all: the probe says why. */
class NoGroups extends UngroupedProcesses {
  override probe(): Promise<ProbeResult> {
    return Promise.resolve({
      available: false as const,
      reason: "unsupported_platform" as const,
      message: unavailableMessage("unsupported_platform"),
    });
  }
}

/** The process groups of this platform: the probe says whether one can be made here. */
export function processGroups(options: ProcessGroupsOptions = {}): ProcessGroups {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return new LinuxProcessGroups(options.linux);
  if (platform === "win32") {
    if (options.runHelper === undefined) throw new Error("runHelper is required on Windows");
    return new WindowsProcessGroups({ helper: options.runHelper });
  }
  return new NoGroups({ ...options.ungrouped, platform });
}

/**
 * A run starts in a process group when the probe says one can be made, and otherwise anyway, in
 * the agent's process tree as TTasks can find it; how it starts is what `kind()` said, which its
 * record keeps. A run keeps what it started in until its end is confirmed: an empty process group, or,
 * without a group, its agent gone after a kill. After a restart, a run is asked about as its
 * record says it started: its group is counted; without one, nothing of it is known alive and its
 * end cannot be confirmed. A run whose record does not say (an earlier build's) is looked for in a
 * group, if one can be made now, but an empty group cannot confirm it: it may never have been there.
 */
export class FallbackProcessGroups implements ProcessGroups {
  readonly #grouped: ProcessGroups;
  readonly #ungrouped: ProcessGroups;
  readonly #available: () => Promise<boolean>;
  /** What each run started in, and whether it was killed since. */
  readonly #started = new Map<string, { readonly box: ProcessGroups; killed: boolean }>();

  constructor(grouped: ProcessGroups, ungrouped: ProcessGroups, available: () => Promise<boolean>) {
    this.#grouped = grouped;
    this.#ungrouped = ungrouped;
    this.#available = available;
  }

  probe(): Promise<ProbeResult> {
    return this.#grouped.probe();
  }

  async kind(): Promise<ProcessGroupKind> {
    return (await this.#now()) ? this.#grouped.kind() : this.#ungrouped.kind();
  }

  async start(spec: ProcessGroupSpec): Promise<StartedAgent> {
    const kind = spec.kind ?? (await this.kind());
    const box = kind === "tree" ? this.#ungrouped : this.#grouped;
    this.#started.set(spec.name, { box, killed: false });
    try {
      return await box.start(spec);
    } catch (error) {
      this.#started.delete(spec.name);
      throw error;
    }
  }

  async interrupt(name: string): Promise<boolean> {
    return (await this.#of(name)).box.interrupt(name);
  }

  async kill(name: string): Promise<void> {
    await (await this.#of(name)).box.kill(name);
    const started = this.#started.get(name);
    if (started !== undefined) started.killed = true;
  }

  async confirmEmpty(name: string, options?: ConfirmOptions): Promise<Confirmation> {
    const { box, known } = await this.#of(name, options?.kind);
    return this.#confirmed(name, known, await box.confirmEmpty(name, options));
  }

  async recover(name: string, options?: ConfirmOptions): Promise<Confirmation> {
    const { box, known } = await this.#of(name, options?.kind);
    const started = this.#started.get(name);
    if (started !== undefined) started.killed = true;
    return this.#confirmed(name, known, await box.recover(name, options));
  }

  /**
   * A run whose end is confirmed is forgotten: nothing more can be done for it. A run not known
   * to have started in the group that answered is never confirmed by its being empty.
   */
  #confirmed(name: string, known: boolean, answer: Confirmation): Confirmation {
    const confirmed: Confirmation =
      !known && answer.state === "empty" ? { state: "unconfirmable" } : answer;
    const started = this.#started.get(name);
    if (
      confirmed.state === "empty" ||
      (confirmed.state === "unconfirmable" && started?.killed === true)
    ) {
      this.#started.delete(name);
    }
    return confirmed;
  }

  /** Where a run is asked about, and whether it is known to have started there. */
  async #of(
    name: string,
    kind?: ProcessGroupKind,
  ): Promise<{ box: ProcessGroups; known: boolean }> {
    const started = this.#started.get(name)?.box;
    if (started !== undefined) return { box: started, known: true };
    if (kind !== undefined) {
      return { box: kind === "tree" ? this.#ungrouped : this.#grouped, known: true };
    }
    return { box: (await this.#now()) ? this.#grouped : this.#ungrouped, known: false };
  }

  async #now(): Promise<boolean> {
    try {
      return await this.#available();
    } catch {
      return false;
    }
  }
}
