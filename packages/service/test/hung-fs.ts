// A disk that stops answering at a path, as a share gone offline does. A test file mocks
// `node:fs/promises` with `hungFs`, and `hang` makes every look at the path, or inside it, wait for
// ever until the test lets it go.
import { sep } from "node:path";
import { vi } from "vitest";

type Fs = typeof import("node:fs/promises");

const hung = new Map<string, () => void>();

const hangs = (path: unknown): (() => void) | undefined => {
  if (typeof path !== "string") return undefined;
  for (const [at, reached] of hung) {
    if (path === at || path.startsWith(`${at}${sep}`)) return reached;
  }
  return undefined;
};

/** `node:fs/promises` whose stat, lstat, readFile and realpath never answer at a hung path. */
export async function hungFs(): Promise<Fs> {
  const fs = await vi.importActual<Fs>("node:fs/promises");
  const held =
    <A extends unknown[], R>(look: (path: unknown, ...rest: A) => Promise<R>) =>
    (path: unknown, ...rest: A): Promise<R> => {
      const reached = hangs(path);
      if (reached === undefined) return look(path, ...rest);
      reached();
      return new Promise<R>(() => undefined);
    };
  return {
    ...fs,
    stat: held(fs.stat as never),
    lstat: held(fs.lstat as never),
    readFile: held(fs.readFile as never),
    realpath: held(fs.realpath as never),
  } as Fs;
}

/** Makes every look at `path` hang; `reached` once one did. `release` ends it for later looks. */
export function hang(path: string): { reached: Promise<void>; release: () => void } {
  let reached = (): void => undefined;
  const started = new Promise<void>((resolve) => (reached = resolve));
  hung.set(path, reached);
  return { reached: started, release: () => hung.delete(path) };
}
