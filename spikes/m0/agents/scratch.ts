// The removal rule of lab run A (M0.09). Every removal the lab code makes goes through one Scratch
// object, which refuses anything that is not strictly inside the run's own scratch folder:
// - the target is resolved (and, when it exists, its real path too) and must lie strictly inside
//   the scratch root: never the root itself, never above it, never a sibling that only shares a
//   prefix. On Windows the comparison ignores case.
// - a folder is removed only when the run's own marker file is in it: the scratch root holds the
//   run's ID, and every folder the lab creates (or reserves before a child creates it) gets a
//   marker with that ID. A folder that existed before the run has no such marker and is refused.
// - a symbolic link or junction is never followed or removed.
// Errors carry fixed messages only (no path), so nothing above can print a path by accident.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** The marker file the lab writes into the scratch root and into every folder it owns. */
export const OWNER_MARKER = ".ttasks-lab-owner";

/** A refusal of the removal rule. The message is one of a fixed set and never holds a path. */
export class ScratchRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ScratchRefusal";
  }
}

const fold = (p: string, win: boolean) => (win ? p.toLowerCase() : p);

/** Whether `target` lies strictly inside `root` after resolution (case-insensitive on Windows). */
export function isStrictlyInside(
  root: string,
  target: string,
  win = process.platform === "win32",
): boolean {
  const rel = relative(fold(resolve(root), win), fold(resolve(target), win));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs);
  const parent = resolve(abs, "..");
  if (parent === abs) return abs;
  return resolve(realish(parent), relative(parent, abs));
}

interface Marker {
  lab: "m0-09";
  run: string;
}

function readMarker(dir: string): Marker | undefined {
  const file = resolve(dir, OWNER_MARKER);
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Partial<Marker>;
    return m.lab === "m0-09" && typeof m.run === "string"
      ? { lab: "m0-09", run: m.run }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface Scratch {
  readonly root: string;
  readonly runId: string;
  /** `target` resolved, if strictly inside the root; refuses otherwise. */
  inside(target: string): string;
  /** Creates a folder inside the root and marks it as the run's own when this call created it. */
  mkdir(dir: string): string;
  /** Records that `dir` does not exist yet and that a child of this run will create it. */
  reserve(dir: string): string;
  /** Marks a folder reserved with `reserve` (now created by a child) as the run's own. */
  claim(dir: string): void;
  /** Removes a file, or a folder that carries the run's marker, strictly inside the root. */
  remove(target: string): void;
}

/**
 * Opens (or creates) the scratch root. A new root gets a marker with a new run ID; an existing
 * root must carry the lab's marker, or be empty (then it is adopted). Anything else is refused.
 */
export function openScratch(root: string, win = process.platform === "win32"): Scratch {
  const abs = resolve(root);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  if (!lstatSync(abs).isDirectory()) throw new ScratchRefusal("scratch root is not a folder");
  let marker = readMarker(abs);
  if (marker === undefined) {
    if (readdirSync(abs).length > 0) {
      throw new ScratchRefusal("scratch root exists without the lab's marker");
    }
    marker = { lab: "m0-09", run: randomUUID() };
    writeFileSync(resolve(abs, OWNER_MARKER), JSON.stringify(marker));
  }
  const runId = marker.run;
  const realRoot = realpathSync.native(abs);
  const reserved = new Set<string>();
  const mark = (dir: string) => {
    writeFileSync(resolve(dir, OWNER_MARKER), JSON.stringify({ lab: "m0-09", run: runId }));
  };

  const inside = (target: string): string => {
    const t = resolve(abs, target);
    if (!isStrictlyInside(abs, t, win) || !isStrictlyInside(realRoot, realish(t), win)) {
      throw new ScratchRefusal("target is not strictly inside the scratch folder");
    }
    return t;
  };

  return {
    root: abs,
    runId,
    inside,
    mkdir(dir) {
      const t = inside(dir);
      const existed = existsSync(t);
      mkdirSync(t, { recursive: true });
      if (!existed) mark(t);
      return t;
    },
    reserve(dir) {
      const t = inside(dir);
      if (existsSync(t)) throw new ScratchRefusal("reserved folder exists already");
      reserved.add(fold(t, win));
      return t;
    },
    claim(dir) {
      const t = inside(dir);
      if (!reserved.has(fold(t, win))) throw new ScratchRefusal("folder was not reserved");
      if (!existsSync(t) || !lstatSync(t).isDirectory()) {
        throw new ScratchRefusal("reserved folder was not created");
      }
      const m = readMarker(t);
      if (m !== undefined && m.run !== runId) throw new ScratchRefusal("folder of another run");
      if (m === undefined) mark(t);
      reserved.delete(fold(t, win));
    },
    remove(target) {
      const t = inside(target);
      if (!existsSync(t)) {
        // A dangling link still exists as an entry: never touched.
        try {
          lstatSync(t);
        } catch {
          return;
        }
        throw new ScratchRefusal("target is a link");
      }
      const st = lstatSync(t);
      if (st.isSymbolicLink()) throw new ScratchRefusal("target is a link");
      // A link or junction anywhere between the root and the target changes the relative path.
      const lexical = relative(fold(abs, win), fold(t, win));
      const real = relative(fold(realRoot, win), fold(realpathSync.native(t), win));
      if (lexical !== real) throw new ScratchRefusal("target is a link");
      if (st.isDirectory()) {
        const m = readMarker(t);
        if (m === undefined || m.run !== runId) {
          throw new ScratchRefusal("folder does not carry this run's marker");
        }
        rmSync(t, { recursive: true, force: true });
        return;
      }
      rmSync(t, { force: true });
    },
  };
}

/** The socket-folder modes E02 knows. Anything else from the environment is refused. */
export const E02_MODES = ["run-user", "state"] as const;
export type E02Mode = (typeof E02_MODES)[number];

/** E02's modes from `TTASKS_M0_E02_MODES` (comma list) or the machine's default. */
export function parseE02Modes(value: string | undefined, win: boolean): E02Mode[] {
  if (value === undefined || value === "") return win ? ["state"] : ["run-user", "state"];
  const modes = value.split(",");
  for (const m of modes) {
    if (!(E02_MODES as readonly string[]).includes(m)) {
      throw new ScratchRefusal("unknown E02 mode");
    }
  }
  return modes as E02Mode[];
}
