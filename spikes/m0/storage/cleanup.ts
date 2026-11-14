// The run folder holds several GB at full scale, so it is removed on every path. When the run
// failed and the folder cannot be removed either, both errors are reported: the original one first,
// because it explains the run, and the removal error with the folder to clean up by hand.
import { rmSync } from "node:fs";

const removeFolder = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
};

/** Runs `body`, then removes `dir` unless `keep`, without ever hiding the body's error. */
export async function inRunFolder<T>(
  dir: string,
  keep: boolean,
  body: () => Promise<T>,
  remove: (dir: string) => void = removeFolder,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    if (keep) throw error;
    try {
      remove(dir);
    } catch (removeError) {
      throw new AggregateError(
        [error, removeError],
        `the run failed, and its temporary folder could not be removed: ${dir}`,
        { cause: removeError },
      );
    }
    throw error;
  }
  if (!keep) {
    try {
      remove(dir);
    } catch (removeError) {
      throw new Error(`the run finished, but its temporary folder could not be removed: ${dir}`, {
        cause: removeError,
      });
    }
  }
  return result;
}

const one = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

/** Every error of a failed run, the original first, for stderr. */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts = error.errors.map(
      (e, i) => `  [${String(i + 1)}] ${one(e).replace(/\n/g, "\n      ")}`,
    );
    return `${error.message}\n${parts.join("\n")}`;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return `${one(error)}\n  caused by: ${one(error.cause).replace(/\n/g, "\n  ")}`;
  }
  return one(error);
}
