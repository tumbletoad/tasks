// A marker's owners file written late, as a loaded machine or a virus scanner holds it. A test file
// mocks `@ttasks/files` with `slowFiles`, and `holdNextWrite` holds the next owners file's write
// until the test lets it land or fail.
import { vi } from "vitest";

type Files = typeof import("@ttasks/files");

let hold: ((write: () => Promise<void>) => Promise<void>) | undefined;

/** `@ttasks/files` whose atomicWriteAsync, the marker's own write, can be held. */
export async function slowFiles(): Promise<Files> {
  const files = await vi.importActual<Files>("@ttasks/files");
  return {
    ...files,
    atomicWriteAsync: (...args: Parameters<Files["atomicWriteAsync"]>) => {
      const write = () => files.atomicWriteAsync(...args);
      return hold === undefined ? write() : hold(write);
    },
  };
}

export interface HeldWrite {
  /** The write has started and is held. */
  readonly reached: Promise<void>;
  /** Lets the write go on, or fails it with `failure`; answers the write's error, if any. */
  readonly land: (failure?: Error) => Promise<unknown>;
}

/** Holds the next owners file's write. */
export function holdNextWrite(): HeldWrite {
  let reached = (): void => undefined;
  const started = new Promise<void>((resolve) => (reached = resolve));
  let release: (failure?: Error) => void = () => undefined;
  const gate = new Promise<Error | undefined>((resolve) => (release = resolve));
  let landed: Promise<unknown> = Promise.resolve();
  hold = (write) => {
    hold = undefined;
    const writing = gate.then((failure) =>
      failure === undefined ? write() : Promise.reject(failure),
    );
    landed = writing.then(
      () => undefined,
      (error: unknown) => error,
    );
    reached();
    return writing;
  };
  return {
    reached: started,
    land: async (failure) => {
      release(failure);
      await started;
      return landed;
    },
  };
}
