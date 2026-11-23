// Run containers: the processes of one background run, ended together and confirmed empty where
// a process group can hold them, and ended as far as TTasks can find them where none can.
import { LinuxContainers, type LinuxOptions } from "./linux.ts";
import { unavailableMessage } from "./placement.ts";
import {
  type ConfirmOptions,
  type Confirmation,
  type Contained,
  type Containers,
  type ContainerSpec,
  type ProbeResult,
} from "./types.ts";
import { UngroupedContainers, type UngroupedOptions } from "./ungrouped.ts";
import { WindowsContainers } from "./windows.ts";

export * from "./types.ts";
export { windowsCommandLine, quoteWindowsArg } from "./command-line.ts";
export { JOIN_FAILED_EXIT, LinuxContainers, type LinuxOptions } from "./linux.ts";
export { MAIN_CGROUP, placement, RUN_HELPER, unavailableMessage } from "./placement.ts";
export { descendants, UngroupedContainers, type UngroupedOptions } from "./ungrouped.ts";
export { jobName, WindowsContainers, type WindowsOptions } from "./windows.ts";

export interface ContainersOptions {
  readonly platform?: NodeJS.Platform;
  /** Windows: the absolute path of ttasks-run.exe. */
  readonly runHelper?: string;
  readonly linux?: LinuxOptions;
  readonly ungrouped?: UngroupedOptions;
}

/** Where no process group exists at all: the probe says why. */
class NoGroups extends UngroupedContainers {
  override probe(): Promise<ProbeResult> {
    return Promise.resolve({
      available: false as const,
      reason: "unsupported_platform" as const,
      message: unavailableMessage("unsupported_platform"),
    });
  }
}

/** The process groups of this platform: the probe says whether one can be made here. */
export function containers(options: ContainersOptions = {}): Containers {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return new LinuxContainers(options.linux);
  if (platform === "win32") {
    if (options.runHelper === undefined) throw new Error("runHelper is required on Windows");
    return new WindowsContainers({ helper: options.runHelper });
  }
  return new NoGroups({ ...options.ungrouped, platform });
}

/**
 * A run starts in a process group when the probe says one can be made, and otherwise anyway, in
 * the agent's process tree as TTasks can find it. A run keeps what it started in until its end is
 * confirmed: an empty container, or, without a group, its agent gone after a kill. After a
 * restart, a run is recovered as the probe says now.
 */
export class FallbackContainers implements Containers {
  readonly #grouped: Containers;
  readonly #ungrouped: Containers;
  readonly #available: () => Promise<boolean>;
  /** What each run started in, and whether it was killed since. */
  readonly #started = new Map<string, { readonly box: Containers; killed: boolean }>();

  constructor(grouped: Containers, ungrouped: Containers, available: () => Promise<boolean>) {
    this.#grouped = grouped;
    this.#ungrouped = ungrouped;
    this.#available = available;
  }

  probe(): Promise<ProbeResult> {
    return this.#grouped.probe();
  }

  async start(spec: ContainerSpec): Promise<Contained> {
    const box = (await this.#now()) ? this.#grouped : this.#ungrouped;
    this.#started.set(spec.name, { box, killed: false });
    try {
      return await box.start(spec);
    } catch (error) {
      this.#started.delete(spec.name);
      throw error;
    }
  }

  async interrupt(name: string): Promise<boolean> {
    return (await this.#of(name)).interrupt(name);
  }

  async kill(name: string): Promise<void> {
    await (await this.#of(name)).kill(name);
    const started = this.#started.get(name);
    if (started !== undefined) started.killed = true;
  }

  async confirmEmpty(name: string, options?: ConfirmOptions): Promise<Confirmation> {
    return this.#confirmed(name, await (await this.#of(name)).confirmEmpty(name, options));
  }

  async recover(name: string, options?: ConfirmOptions): Promise<Confirmation> {
    const box = await this.#of(name);
    const started = this.#started.get(name);
    if (started !== undefined) started.killed = true;
    return this.#confirmed(name, await box.recover(name, options));
  }

  /** A run whose end is confirmed is forgotten: nothing more can be done for it. */
  #confirmed(name: string, confirmed: Confirmation): Confirmation {
    const started = this.#started.get(name);
    if (
      confirmed.state === "empty" ||
      (confirmed.state === "unconfirmable" && started?.killed === true)
    ) {
      this.#started.delete(name);
    }
    return confirmed;
  }

  async #of(name: string): Promise<Containers> {
    return this.#started.get(name)?.box ?? ((await this.#now()) ? this.#grouped : this.#ungrouped);
  }

  async #now(): Promise<boolean> {
    try {
      return await this.#available();
    } catch {
      return false;
    }
  }
}
