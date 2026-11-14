// A fake DetectHost: an in-memory file system with fixture paths of any OS, fake command outputs,
// and a record of every path detection looked at, so a test can prove what it never touched.
// Tests only.
import { posix, win32 } from "node:path";
import type { DetectHost, Env, FileFacts } from "../src/detect.ts";

export type FakeEntry =
  | { readonly kind: "dir" }
  | { readonly kind: "file"; readonly executable?: boolean }
  | { readonly kind: "link"; readonly to: string };

export interface FakeHostSpec {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Env;
  readonly entries: Readonly<Record<string, FakeEntry>>;
  /** `--version` output by the command line it was run with, joined with spaces. */
  readonly outputs?: Readonly<Record<string, string>>;
}

export interface FakeHost extends DetectHost {
  /** Every path stat'd, listed or resolved, in order. */
  readonly touched: string[];
  /** Every command line run, joined with spaces. */
  readonly ran: string[];
}

export function fakeHost(spec: FakeHostSpec): FakeHost {
  const p = spec.platform === "win32" ? win32 : posix;
  const norm = (path: string) => {
    const n = p.normalize(path);
    return spec.platform === "win32" ? n.toLowerCase() : n;
  };
  const entries = new Map<string, FakeEntry>();
  // The spelling of each entry's path, for listings that keep the case on Windows.
  const names = new Map<string, string>();
  for (const [path, entry] of Object.entries(spec.entries)) {
    entries.set(norm(path), entry);
    names.set(norm(path), path);
    // Parent folders exist.
    let dir = p.dirname(path);
    while (dir !== p.dirname(dir)) {
      if (!entries.has(norm(dir))) {
        entries.set(norm(dir), { kind: "dir" });
        names.set(norm(dir), dir);
      }
      dir = p.dirname(dir);
    }
  }
  const resolve = (path: string, depth = 0): string | undefined => {
    const entry = entries.get(norm(path));
    if (entry === undefined || depth > 8) return undefined;
    if (entry.kind === "link") return resolve(p.resolve(p.dirname(path), entry.to), depth + 1);
    return path;
  };
  const touched: string[] = [];
  const ran: string[] = [];
  return {
    platform: spec.platform,
    env: spec.env,
    home: spec.home,
    touched,
    ran,
    stat(path): FileFacts | undefined {
      touched.push(path);
      const real = resolve(path);
      if (real === undefined) return undefined;
      const entry = entries.get(norm(real));
      if (entry === undefined || entry.kind === "link") return undefined;
      if (entry.kind === "dir") return { kind: "dir", executable: false };
      return { kind: "file", executable: spec.platform === "win32" || entry.executable === true };
    },
    list(dir) {
      touched.push(dir);
      const real = resolve(dir);
      if (real === undefined || entries.get(norm(real))?.kind !== "dir") return undefined;
      const prefix = norm(real) + p.sep;
      const out = new Set<string>();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest === "" || rest.includes(p.sep)) continue;
        const original = names.get(key);
        out.add(original === undefined ? rest : p.basename(original));
      }
      return [...out];
    },
    realpath(path) {
      touched.push(path);
      return resolve(path);
    },
    output(file, args) {
      const line = [file, ...args].join(" ");
      ran.push(line);
      return Promise.resolve(spec.outputs?.[line]);
    },
  };
}
