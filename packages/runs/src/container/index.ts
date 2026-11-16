// Run containers: the processes of one background run, ended together and confirmed empty.
import { LinuxContainers, type LinuxOptions } from "./linux.ts";
import { unavailableMessage } from "./placement.ts";
import { ContainerError, type Containers } from "./types.ts";
import { WindowsContainers } from "./windows.ts";

export * from "./types.ts";
export { windowsCommandLine, quoteWindowsArg } from "./command-line.ts";
export { JOIN_FAILED_EXIT, LinuxContainers, type LinuxOptions } from "./linux.ts";
export { MAIN_CGROUP, placement, RUN_HELPER, unavailableMessage } from "./placement.ts";
export { jobName, WindowsContainers, type WindowsOptions } from "./windows.ts";

export interface ContainersOptions {
  readonly platform?: NodeJS.Platform;
  /** Windows: the absolute path of tasks-run.exe. */
  readonly runHelper?: string;
  readonly linux?: LinuxOptions;
}

/** Where nothing can be contained: the probe says why, and nothing starts. */
class Uncontained implements Containers {
  probe() {
    return Promise.resolve({
      available: false as const,
      reason: "unsupported_platform" as const,
      message: unavailableMessage("unsupported_platform"),
    });
  }
  start() {
    return Promise.reject(
      new ContainerError("unavailable", unavailableMessage("unsupported_platform")),
    );
  }
  interrupt() {
    return Promise.resolve(false);
  }
  kill() {
    return Promise.resolve();
  }
  confirmEmpty() {
    return Promise.resolve({ state: "empty" as const });
  }
  recover() {
    return Promise.resolve({ state: "empty" as const });
  }
}

/** The containers of this platform. */
export function containers(options: ContainersOptions = {}): Containers {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return new LinuxContainers(options.linux);
  if (platform === "win32") {
    if (options.runHelper === undefined) throw new Error("runHelper is required on Windows");
    return new WindowsContainers({ helper: options.runHelper });
  }
  return new Uncontained();
}
