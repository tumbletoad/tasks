// A caller's place field as a place of this machine (A1 3.15, A3 3.4.5, R11; M2.07). A place
// arrives in one of three forms: `"cwd"` (the caller's working folder, from its `cwd` field), an
// absolute folder, or a root and a relative path. The first two are turned into the closest root
// of this machine and a relative path (launch's `placeOf`), so the space only ever receives a root
// ID and a relative path: no absolute path reaches the space, a commit, a receipt, a log line or
// an error (which names the field, the reason and root IDs). At bind time the folder's Git remote
// is read from the repository's config file and recorded as the place's identity.
import { PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import {
  isPlacePath,
  placeOf,
  resolvePlace,
  type BindReason,
  type GitRemote,
  type RootFolder,
} from "@tasks/launch";
import { bounded, LOOK_MS } from "./folders.ts";

/** What a `place.set` takes from a bound place. */
export interface PlaceFields {
  readonly root: string;
  readonly path: string;
  readonly git_remote?: string;
}

export type Bound =
  | {
      readonly kind: "place";
      readonly place: PlaceFields;
      /**
       * The folder holds a repository whose config could not be read exactly (an include, a URL
       * rewrite, a syntax git refuses …): the place is bound without a remote, so it has no remote
       * check, and the caller says so (`remoteWarning`).
       */
      readonly remoteUnreadable: boolean;
    }
  /** Under no root of this machine (A1 `PLACE_OUTSIDE_ROOTS`), with every root ID. */
  | { readonly kind: "outside"; readonly roots: readonly string[] };

/** Why a place field is refused. */
type Reason = BindReason | "no_cwd" | "unknown_root" | "not_answering";

/** The fixed sentence of each reason a place field is refused. Never a value. */
const SENTENCES: Readonly<Record<Reason, string>> = {
  not_absolute: "Not an absolute folder on this machine",
  invalid_path: "A folder a place cannot name exactly",
  path_missing: "The folder is not there",
  not_a_directory: "Not a folder",
  outside_roots: "The folder is under no root of this machine",
  ambiguous_root: "Two roots of this machine name this folder",
  identity_unavailable: "The folder's volume gives no file identity, so a place cannot name it",
  no_cwd: "A place given as cwd needs cwd, the working folder",
  unknown_root: "Two roots have this label",
  not_answering: "The folder did not answer in time",
};

const HINTS: Partial<Record<Reason, string>> = {
  outside_roots: "Roots are retired: the person gives the task or its project a folder.",
  ambiguous_root: "Keep one of the roots that name this folder in machine.toml.",
  no_cwd: "Pass cwd as an absolute path.",
  unknown_root: "Name the root by its ID: tasks roots.",
  not_answering: "Check that its drive or share is connected, then try again.",
};

/** How long binding one place may take: it reads the folder, every root and the Git config. */
const BIND_MS = 3 * LOOK_MS;

/**
 * The refusal of a place field at `at`: `invalid_input` with the reason, A1's cause for a folder
 * under no root, and root IDs where they help. No path, given or found.
 */
export function placeRefused(at: string, reason: Reason, roots?: readonly string[]): AppError {
  const message = SENTENCES[reason];
  const hint = HINTS[reason];
  return new AppError({
    code: "invalid_input",
    message: `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    data: {
      issues: [{ path: at, message }],
      reason,
      ...(reason === "outside_roots" ? { cause: "PLACE_OUTSIDE_ROOTS" } : {}),
      ...(roots === undefined ? {} : { roots: [...roots] }),
    },
  });
}

/**
 * The warning of a draft whose folder is under no root (A3 3.4.5): the task is created without a
 * place. It names no root, so a replay, which reads the stored result, warns the same.
 */
export function outsideWarning(at: string): string {
  return `${at}: the folder is under no root of this machine, so the task has no place (PLACE_OUTSIDE_ROOTS). Roots are retired: the person gives the task or its project a folder.`;
}

/**
 * The warning of a place bound without a remote because its repository's config could not be read
 * exactly (A1 3.15): the place has no remote check. It names no path. A replay binds
 * nothing, so it does not repeat it.
 */
export function remoteWarning(at: string): string {
  return `${at}: the repository's Git config could not be read exactly (an include, a URL rewrite or a syntax ${PRODUCT_NAME} does not read), so the place has no remote check (PLACE_REMOTE_UNREADABLE).`;
}

/** A remote as a place records it, and whether it was unreadable. */
function recorded(remote: GitRemote | undefined): {
  readonly fields: { readonly git_remote?: string };
  readonly unreadable: boolean;
} {
  return {
    fields: remote?.status === "remote" ? { git_remote: remote.url } : {},
    unreadable: remote?.status === "unreadable",
  };
}

/**
 * Binds one place field of the input on this machine. `value` is the field as parsed (`"cwd"`, an
 * absolute folder, or `{root, path}`), `cwd` the input's `cwd`. Throws the refusal of a field this
 * machine cannot bind; a folder under no root is `outside`, which the caller refuses or warns of.
 *
 * A root and path is bound as given when it does not resolve here (the folder may come later, as
 * A1 allows), but it must be a place's path by this machine's rules. A root given by its label is
 * the root with that label when no root has it as its ID.
 *
 * A binding that takes longer than BIND_MS is refused as `not_answering`, so a share that does not
 * answer holds up the call, and the space's calls that wait for its turn, no longer than that.
 */
export async function bindPlace(
  value: unknown,
  cwd: unknown,
  roots: readonly (RootFolder & { readonly label?: string })[],
  at: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Bound> {
  const found = await bounded(() => bindNow(value, cwd, roots, at, platform), BIND_MS);
  if (found === "not_answering") throw placeRefused(at, "not_answering");
  return found;
}

async function bindNow(
  value: unknown,
  cwd: unknown,
  roots: readonly (RootFolder & { readonly label?: string })[],
  at: string,
  platform: NodeJS.Platform,
): Promise<Bound> {
  if (typeof value === "object" && value !== null) {
    const given = value as { root?: unknown; path?: unknown };
    const path = String(given.path);
    let root = String(given.root);
    if (!roots.some((r) => r.id === root)) {
      const labelled = roots.filter((r) => r.label?.toLowerCase() === root.toLowerCase());
      if (labelled.length > 1) throw placeRefused(`${at}.root`, "unknown_root");
      if (labelled[0] !== undefined) root = labelled[0].id;
    }
    if (!isPlacePath(path, platform)) throw placeRefused(`${at}.path`, "invalid_path");
    const found = await resolvePlace({ root, path }, roots, { platform });
    const remote = recorded(found.status === "ok" ? found.remote : undefined);
    return {
      kind: "place",
      place: { root, path, ...remote.fields },
      remoteUnreadable: remote.unreadable,
    };
  }
  let folder: string;
  if (value === "cwd") {
    if (typeof cwd !== "string") throw placeRefused("cwd", "no_cwd");
    folder = cwd;
  } else folder = String(value);
  const bound = await placeOf(folder, roots, { platform });
  if (bound.status === "failed") {
    if (bound.reason === "outside_roots") return { kind: "outside", roots: bound.roots ?? [] };
    throw placeRefused(value === "cwd" ? "cwd" : at, bound.reason, bound.roots);
  }
  const remote = recorded(bound.remote);
  return {
    kind: "place",
    place: { root: bound.root, path: bound.path, ...remote.fields },
    remoteUnreadable: remote.unreadable,
  };
}
