// Open and Copy for a task (A4 3.4.2, 3.4.3, 3.4.6, 3.15; A5 3.8 `launch.open`): what the service
// needs around the launch machine to turn a click into an intent and its route's one external
// call. The choice of route per instance, the facts a launch reads about its task, the names the
// brief takes from the registry, and the one fact a Codex launch reads from its home.
import { join } from "node:path";
import { CLI_NAME, envVar, MCP_SERVER_KEY } from "@ttasks/brand";
import { cliFaces, findEntry } from "@ttasks/contracts";
import {
  instanceHome,
  isBuiltInTarget,
  isToolEnvList,
  routeOf,
  targetDef,
  type BriefComposer,
  type BriefKind,
  type BriefNames,
  type Instance,
  type LaunchIntent,
  type PackInput,
  type ResolveReason,
  type Route,
} from "@ttasks/launch";
import { decodeConfig, parseToml, readConfigFile } from "../config/toml.ts";
import type { UsableSpace } from "../ops/served.ts";
import type { MarkerOwner } from "../ops/marker.ts";
import type { TaskFolder } from "../ops/read.ts";

/** Why an instance cannot open a task here: one word, which the page and the CLI word for people. */
export const UNAVAILABLE_REASONS = [
  /** No such enabled instance on this machine (A4 3.2 "Not set up on this machine"). */
  "not_set_up",
  /** The instance's target has no route this build opens (T3 through its own route, apps later). */
  "no_route",
  /** No product command or terminal for a terminal route. */
  "no_terminal",
  /** The task's folder, or its project's, is on another machine only: it opens there. */
  "other_machine",
  /** `claude-cli://` refuses a UNC folder (A4 3.3 step 4). */
  "unc",
  /** The brief does not fit the route's budget (A4 3.15.3). */
  "too_long",
  /** The agent's home is registered for another space: its agent could not use TTasks here. */
  "other_space",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * A click whose folder cannot be used on this machine now (it is not there, or not a folder): no
 * intent is made and nothing starts. The reason is a fixed word (places.ts).
 */
export class LaunchFolderUnavailable extends Error {
  override readonly name = "LaunchFolderUnavailable";
  readonly reason: ResolveReason;
  /** The folder as the space stores it; none for the space's work folder. */
  readonly folder: string | undefined;
  constructor(reason: ResolveReason, folder?: string) {
    super(`The task's folder cannot be used on this machine: ${reason}`);
    this.reason = reason;
    this.folder = folder;
  }
}

/**
 * A click whose folder may not be the one set for the task (marker.ts): its marker names other
 * owners only (`marker_other`), or this machine marked it and the marker is gone
 * (`marker_missing`). Nothing starts; the person may open it anyway, which marks it.
 */
export class LaunchFolderUnmarked extends Error {
  override readonly name = "LaunchFolderUnmarked";
  readonly reason: "marker_missing" | "marker_other";
  /** The folder as the space stores it. */
  readonly folder: string;
  /** Whose folder the launch uses: the task's own or its project's. */
  readonly of: "task" | "project";
  /** The owners the marker names instead. */
  readonly owners: readonly MarkerOwner[];
  constructor(
    reason: "marker_missing" | "marker_other",
    folder: string,
    of: "task" | "project",
    owners: readonly MarkerOwner[] = [],
  ) {
    super(`The task's folder may be another folder: ${reason}`);
    this.reason = reason;
    this.folder = folder;
    this.of = of;
    this.owners = owners;
  }
}

/**
 * The space the agent home a terminal click records is registered for, when its live registration
 * names another space than `space`: a session there could not use TTasks. Undefined when the home
 * may use `space`, has no live registration, or its registrations could not be read.
 */
export type RegisteredElsewhere = (
  app: string,
  home: string | undefined,
  space: string,
) => string | undefined;

export class LaunchUnavailable extends Error {
  override readonly name = "LaunchUnavailable";
  readonly reason: UnavailableReason;
  /** `other_space`: the name of the space the home is registered for, when it is served. */
  readonly works: string | undefined;
  constructor(reason: UnavailableReason, works?: string) {
    super(`This instance cannot open the task here: ${reason}`);
    this.reason = reason;
    this.works = works;
  }
}

/** What a launch reads about its task (the request path reads it, in one snapshot). */
export interface LaunchTask {
  /** `t_` ID. */
  readonly id: string;
  /** Its reference, such as `M-14`. */
  readonly ref: string;
  /** Its title as the space holds it: the brief sanitises it. */
  readonly title: string;
  readonly version: number;
  /** Where it opens on this machine: its own folder, its project's, another machine or none. */
  readonly folder: TaskFolder;
}

/** A click on Open or Copy (`launch.open`). */
export interface OpenTaskRequest {
  /** The copy the click named, which takes changes: its launch records go there. */
  readonly space: UsableSpace;
  readonly task: LaunchTask;
  /** The instance's key; undefined is Copy (A4 3.4.6). */
  readonly instance: string | undefined;
  /**
   * The person's own words for the agent (A5 3.8): an Open route saves them on the task as the
   * launch's request (`saveNote`), Copy puts them on the clipboard.
   */
  readonly composer: string | undefined;
  /**
   * Open with a note of the person's already on the task as the request, its entry reference: the
   * request path read it, and `composer` holds its text. Nothing new is saved.
   */
  readonly requestNote?: string;
  /** The click's request ID (A1 3.8): a repeat replays the same intent. */
  readonly requestId: string;
  /**
   * Saves the person's words as a note of theirs on the task, before the intent is recorded, and
   * gives its entry reference: an Open route's request, or Copy's words over its budget addressed to
   * agents (A4 3.15.3). The request path saves it under a request ID the click's derives, so a
   * repeated click gets the same note.
   */
  readonly saveNote: (text: string, forAgents: boolean) => Promise<string>;
  /**
   * Shift+Copy (A4 3.15.5): the task's text as the request path read it, for the context pack in
   * place of the pointer brief. Only with Copy (no instance).
   */
  readonly pack?: PackContent;
  /**
   * The person chose to open the task in its folder although its marker named another owner or
   * was gone: the folder is marked as this task's or its project's, and opens.
   */
  readonly markFolder?: boolean;
  /**
   * The person chose "Open another": a second session of the app on the task, although one runs
   * here. Without it, an Open of an app that runs the task here is that session.
   */
  readonly another?: boolean;
}

/** What the context pack takes of the task (A4 3.15.5); the launch adds its reference and folder. */
export type PackContent = Omit<
  PackInput,
  "task" | "title" | "reference" | "folder" | "budget" | "composer"
>;

/** What the click gives back. */
export interface OpenTaskResult {
  readonly intent: LaunchIntent;
  /** Text for the person's clipboard: Copy's pointer brief, the Codex assisted open's brief. */
  readonly copy: string | undefined;
  /** Where the composer text went: `request` is the note the launch names, which the agent reads. */
  readonly composer: BriefComposer;
  /** The note that holds the words, for `request` and `note`. */
  readonly note?: string;
  /** The sanitiser removed something from the composer text (A4 3.15.6's quiet notice). */
  readonly removed: boolean;
}

/** The route an instance takes for a click, and its brief. */
export interface Choice {
  readonly route: Route;
  readonly kind: BriefKind;
  /** The route's budget (A4 3.15.3). */
  readonly budget: number;
  /** Terminal routes: `sent`, or Codex's assisted open (`clipboard`). */
  readonly prompt?: "sent" | "clipboard";
  /** The brief goes on the clipboard as well (Copy, the assisted open). */
  readonly copy: boolean;
}

/** Copy (A4 3.4.6): the pointer brief on the clipboard, a launch with route `clipboard`. */
export const COPY: Choice = {
  route: "clipboard",
  kind: "pointer",
  budget: routeOf("clipboard", "clipboard")?.budget ?? 20_000,
  copy: true,
};

/** The instance key a Copy launch records (the catalogue's single clipboard target). */
export const COPY_INSTANCE = "clipboard";

/**
 * Whether Claude Code's `claude-cli://` link may serve the instance (A4 3.4.2): the link always
 * opens the default config home, so only the instance whose home is the default has it, by the
 * rule setup uses too (instanceHome: a home variable in any case on Windows selects another).
 */
export function defaultClaudeHome(
  instance: Instance,
  home: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  return instanceHome(instance, home, platform)?.isDefault === true;
}

/**
 * The route a click takes on an instance (A4 3.4): the primary unless it is unavailable before
 * dispatch or the instance asks for the prefill route (`prompt = "prefill"`, A4 L7). A fallback is
 * never chosen after a dispatch.
 */
export function chooseRoute(
  instance: Instance,
  options: {
    readonly terminal: boolean;
    readonly home: string | undefined;
    readonly platform: NodeJS.Platform;
  },
): Choice {
  if (!instance.enabled || !isBuiltInTarget(instance.target)) {
    throw new LaunchUnavailable("not_set_up");
  }
  const terminal = options.terminal && instance.exec !== undefined;
  switch (instance.target) {
    case "claude-cli": {
      const link = routeOf("claude-cli", "link");
      const primary = routeOf("claude-cli", "terminal", "sent");
      if (instance.prompt === "sent" && terminal && primary !== undefined) {
        return {
          route: "terminal",
          kind: "sent",
          budget: primary.budget,
          prompt: "sent",
          copy: false,
        };
      }
      if (link !== undefined && defaultClaudeHome(instance, options.home, options.platform)) {
        return { route: "link", kind: "prefilled", budget: link.budget, copy: link.copyBriefToo };
      }
      throw new LaunchUnavailable(terminal ? "no_route" : "no_terminal");
    }
    case "codex-cli": {
      if (!terminal) {
        throw new LaunchUnavailable(instance.exec === undefined ? "not_set_up" : "no_terminal");
      }
      const assisted = instance.prompt === "prefill";
      const route = routeOf("codex-cli", "terminal", assisted ? "clipboard" : "sent");
      if (route === undefined) throw new LaunchUnavailable("no_route");
      return {
        route: "terminal",
        kind: assisted ? "prefilled" : "sent",
        budget: route.budget,
        prompt: assisted ? "clipboard" : "sent",
        copy: route.copyBriefToo,
      };
    }
    case "claude-desktop":
    case "codex-app": {
      // The best-effort apps (A4 3.4.4, 3.4.5): their one link, with the brief on the clipboard
      // too, because the app may drop the prefill. A deep link cannot choose an account (A4 L3).
      const link = routeOf(instance.target, "link");
      if (link === undefined) throw new LaunchUnavailable("no_route");
      return { route: "link", kind: "prefilled", budget: link.budget, copy: link.copyBriefToo };
    }
    default:
      // T3 opens through its own route (M2.11); custom targets come later.
      throw new LaunchUnavailable("no_route");
  }
}

/** The glyph a target shows on its tile (A4 3.2: a neutral monogram). */
export const glyphOf = (instance: Instance): string =>
  isBuiltInTarget(instance.target) ? targetDef(instance.target).glyph : "Cu";

/** The names the brief takes from the registry (A4 3.15.1): the read tool and its CLI verb. */
export function briefNames(): BriefNames {
  const entry = findEntry("task.get");
  const tool = entry?.faces.mcp?.tool ?? "get_task";
  const verb = entry === undefined ? undefined : cliFaces(entry)[0]?.verb;
  return { server: MCP_SERVER_KEY, tool, command: `${CLI_NAME} ${verb ?? "show"}` };
}

/**
 * The Codex home an instance's agent uses (instanceHome, the rule setup shares): the `CODEX_HOME`
 * its env sets (in any case on Windows), else its config home, else the default.
 */
export function codexHomeOf(
  instance: Instance,
  home: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  return instanceHome(instance, home, platform)?.path;
}

/**
 * Whether TTasks's MCP entry in a Codex home declares the ticket in `env_vars` (A4 3.4.3): read
 * only, one key of `<home>/config.toml`, through the bounded reader machine.toml uses. Nothing of
 * the file is kept or logged but the names the entry lists, which the override must repeat (a
 * `-c` override replaces the whole list). `unknown` when it cannot be read, or lists something
 * other than plain variable names: the launch then adds nothing, since an override on a home
 * without the entry would make an entry without a command, and one that drops a name would change
 * what the person's entry passes.
 */
export function codexEntryOf(
  home: string,
):
  | { readonly kind: "has_env_vars" | "absent" | "unknown" }
  | { readonly kind: "lacks_env_vars"; readonly names: readonly string[] } {
  const read = readConfigFile(join(home, "config.toml"));
  if (read.kind === "missing") return { kind: "absent" };
  if (read.kind !== "bytes") return { kind: "unknown" };
  const decoded = decodeConfig(read.bytes);
  if (!decoded.ok) return { kind: "unknown" };
  const parsed = parseToml(decoded.text);
  if (!parsed.ok) return { kind: "unknown" };
  const servers = parsed.doc["mcp_servers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { kind: "absent" };
  }
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_KEY];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return { kind: "absent" };
  const names = (entry as Record<string, unknown>)["env_vars"];
  if (names === undefined) return { kind: "lacks_env_vars", names: [] };
  if (!Array.isArray(names) || !isToolEnvList(names)) return { kind: "unknown" };
  return names.includes(envVar("TICKET"))
    ? { kind: "has_env_vars" }
    : { kind: "lacks_env_vars", names };
}
