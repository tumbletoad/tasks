// The page's agent apps (Settings, and the first start): what was found on this machine, and per
// app and home two switches, each the person's own act when they press Apply:
//
//   open   "Open tasks in this app": the home's [[instance]] in machine.toml (instances.ts), which
//          Open's tiles start the agent with
//   tools  "Give this app the TTasks tools": the app's own entry for TTasks in that home
//          (setup/agents.ts), with its agent-home row (agent-homes.ts)
//
//   view   every row and switch as it stands, each switch with what turning it over writes or
//          takes out, and a token of exactly that
//   apply  the switches the person turned over, each with the token its view showed
//
// The engine is the command line's own: the same detection, the same homes, the same refusals and
// the same setup lock, so a page and `ttasks setup agents` never change a home at once. It runs here,
// in the service, with the person's environment as Open's agents get it, so it finds the commands
// the person's own shell finds.
//
// Apply looks again under the lock: a switch whose token is not the one the person saw (a home
// that changed since, an app that came or went) is not applied, and neither is any other: the page
// gets the new view to show instead. Only the person can call these (the UI's sign-in, or a person
// at a terminal): an agent's connection, a script and the bridge are refused before anything is read.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import {
  detect,
  envValue,
  instanceEntry,
  instanceHome,
  nodeDetectHost,
  type Env,
  type EnvironmentSource,
  type Instance,
  type Proposal,
} from "@ttasks/launch";
import { isId } from "@ttasks/storage";
import { loadMachineConfig, MACHINE_TOML } from "../config/machine-toml.ts";
import type { ConnectionClass, Grant } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import {
  appLabel,
  applyHome,
  blockOf,
  entryLines,
  LockBusy,
  planChange,
  planOf,
  planToken,
  recordFile,
  removeHome,
  rowAccess,
  runCommand,
  samePath,
  SetupStateInvalid,
  SetupStateUnsafe,
  settleHomes,
  survey,
  toolsOf,
  t3Proposals,
  t3SettingsOf,
  wireOf,
  withSetupLock,
  type AgentApp,
  type HomeView,
  type ToolsAnswer,
  type Offer,
  type PlanItem,
  type SetupInput,
} from "../setup/index.ts";
import { agentHomeVerbs, type AgentHomesHost } from "./agent-homes.ts";
import { instanceVerbs, readInstancesRecord, type InstancesHost } from "./instances.ts";

export interface AgentAppsHost {
  readonly platform: NodeJS.Platform;
  readonly configDir: string;
  readonly stateDir: string;
  /** The install's stable command, which every entry runs. */
  readonly tasks: string;
  /** The account's home folder: where detection looks, and what a path shows as `~`. */
  readonly userHome: string | undefined;
  /** The person's environment, as Open's agents get it. */
  env(): Promise<Env>;
  readonly homes: AgentHomesHost;
  readonly instances: InstancesHost;
  /** A served space's name, for a home whose tools work in another space. */
  spaceName(id: string): string | undefined;
}

/**
 * Why a switch cannot be turned over here, or what to know about it, as a fixed word: open's
 * `by_hand` (machine.toml names it, written by hand), `no_command`, `needs_home`, `id_taken`; tools'
 * `not_installed` (TTasks's command is not where the entry would run it), `edited`, `missing`,
 * `interrupted`, `entry_left` (the access is off and its entry is still in its file),
 * `file_unreadable` (setup cannot read the file as it is now), `other_space`, `several` (one of
 * several Claude Desktop files: the person picks), or one of setup's other refusals.
 */
export type Why = string;

export interface Part {
  /** On now. */
  readonly on: boolean;
  /** What turning it over does; null when the page cannot turn it over. */
  readonly change: "add" | "remove" | null;
  readonly why?: Why;
  /** The file that changes, its home shown as `~`. */
  readonly file: string;
  /** Exactly what changes in `file`: the lines that are written or taken out. */
  readonly detail: readonly string[];
  /** A token of this switch as shown: apply goes on only with the same one. */
  readonly plan: string;
  /** tools: the space the entry names, when it names one. */
  readonly space?: { readonly id: string; readonly name: string | null };
  /**
   * tools that show off while their access may be live (the entry or the program it runs is gone):
   * turning them off all the same, what it takes out and its token.
   */
  readonly off?: { readonly detail: readonly string[]; readonly plan: string };
}

export interface AppRow {
  readonly key: string;
  readonly app: AgentApp | "t3";
  readonly label: string;
  /** The home, shown with `~`; null for T3 Code, whose instances are in its own settings. */
  readonly home: string | null;
  /** Other apps that read this home's tools: the Codex app, T3 Code. */
  readonly also: readonly string[];
  /**
   * Found by its folder's name alone (`.codex-backup`): no settings file of the app is in it, and
   * nothing else says an app uses it, so the first start leaves its switches off.
   */
  readonly byName?: true;
  readonly open?: Part;
  readonly tools?: Part;
}

export interface AppsView {
  /** The space a new entry names: the tab's. */
  readonly space: string;
  readonly rows: readonly AppRow[];
  /**
   * Setup's own record, shown with `~`, when it cannot be read: each home's access can be turned
   * off, and nothing else changes until it can be read.
   */
  readonly record?: string;
}

export interface AppsChange {
  readonly key: string;
  readonly part: "open" | "tools";
  readonly on: boolean;
  readonly plan: string;
}

export interface AppsOutcome {
  readonly key: string;
  readonly part: "open" | "tools";
  readonly result: "done" | "failed";
  readonly reason?: string;
  /** open, failed: the key of its entry the service refused (`label`). */
  readonly field?: string;
  /**
   * tools turned off: the app's access is off, and its entry stayed in its file, for `reason`
   * (`edited`: the person changed it, so it is theirs).
   */
  readonly kept?: true;
  /** tools, failed: the service did not confirm that the access is off, so the entry stayed too. */
  readonly unconfirmed?: true;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

const TARGET: Readonly<Record<"claude-code" | "codex", Instance["target"]>> = {
  "claude-code": "claude-cli",
  codex: "codex-cli",
};

/** A text attribute of a grant row, or empty. */
const attr = (grant: Grant, key: string): string => {
  const value = grant.attrs[key];
  return typeof value === "string" ? value : "";
};

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can change this machine's agent apps.",
      hint: "Ask the user to do this in Settings.",
      data: { rule: "user_only" },
    });
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path as the person reads it: the home folder as `~`. */
export function shownPath(
  platform: NodeJS.Platform,
  home: string | undefined,
  path: string,
): string {
  if (home === undefined || home === "") return path;
  const p = pathOf(platform);
  const relative = p.relative(home, path);
  if (relative === "") return "~";
  if (relative.startsWith("..") || p.isAbsolute(relative)) return path;
  return `~${p.sep}${relative}`;
}

/** A home's plan, and whether it is one of several Claude Desktop files the person picks from. */
type Planned = PlanItem & { readonly several?: true };

/** What one look found: the view, and what apply needs to carry each switch out. */
interface Look {
  readonly view: AppsView;
  readonly input: SetupInput;
  readonly items: ReadonlyMap<string, PlanItem>;
  readonly offers: ReadonlyMap<string, Offer>;
  readonly owners: ReadonlyMap<string, string>;
}

/** The space every new entry names: a space this service serves. */
function spaceOf(params: JsonObject, host: AgentAppsHost): string {
  const space = params["space"];
  if (
    !isId(space, "sp") ||
    !host.homes.spaces().some((s) => s.id === space && s.state !== "closed")
  ) {
    throw new AppError({
      code: "invalid_input",
      message: "Expected a space this service serves.",
      data: { issues: [{ path: "space", message: "Not a served space" }] },
    });
  }
  return space;
}

/** Everything the page shows, read now. Writes nothing. */
async function look(host: AgentAppsHost, space: string): Promise<Look> {
  const { platform } = host;
  const userHome = host.userHome ?? "";
  const shown = (path: string) => shownPath(platform, host.userHome, path);
  const env = await host.env();
  const machine = loadMachineConfig(host.configDir, platform).config;
  const detection = await detect(nodeDetectHost({ platform, env, home: userHome }));
  const rows = host.homes
    .grants()
    .list("agent_home")
    .filter((grant) => grant.revoked_at === null)
    .map((grant) => ({
      app: attr(grant, "app"),
      home: attr(grant, "home"),
      instance: attr(grant, "instance"),
    }));
  const input: SetupInput = {
    platform,
    userHome,
    env,
    stateDir: host.stateDir,
    tasks: host.tasks,
    detection,
    instances: machine.instances,
    managedPaths: machine.setup.managedPaths,
    rows,
    isFolder,
    run: (argv, childEnv) => runCommand(argv, childEnv, userHome),
  };
  const views = userHome === "" ? [] : await survey(input);
  const answerOf = ({ view, change }: PlanItem) =>
    toolsOf(input, view, space, typeof change === "string" ? change : undefined);
  // Claude Desktop with several settings files (a Windows app installed twice over the years): the
  // engine changes none of them on its own, and here the person picks one with its switch.
  // A change that did not finish shows what turning it on writes once it is finished.
  const plan = planOf(input, views, space).map((item): Planned =>
    item.change === "ambiguous"
      ? { view: item.view, change: planOf(input, [item.view], space)[0]?.change, several: true }
      : item.view.state === "interrupted"
        ? { view: item.view, change: planChange(input, item.view, space) }
        : item,
  );
  const written = readInstancesRecord(host.stateDir);
  const configFile = shown(pathOf(platform).join(host.configDir, MACHINE_TOML));

  const items = new Map<string, PlanItem>();
  /** Each row's offer for machine.toml, by the row's key. */
  const byRow = new Map<string, Offer>();
  const owners = new Map<string, string>();
  const out: (Omit<AppRow, "open"> & { open?: Part | "offer" })[] = [];

  const fixed = (key: string, on: boolean, why: Why): Part => ({
    on,
    change: null,
    why,
    file: configFile,
    detail: [],
    plan: digest([key, why]),
  });
  /** The open switch of a row that machine.toml names already. */
  const ownedPart = (key: string, owner: Instance): Part => {
    owners.set(key, owner.id);
    const mine = written.find((r) => r.id === owner.id);
    if (mine === undefined) return fixed(key, true, "by_hand");
    return {
      on: true,
      change: "remove",
      file: configFile,
      detail: blockOf(new Map(mine.entries)).map((line) => `- ${line}`),
      plan: digest([key, "remove", mine.entries]),
    };
  };
  const offerPart = (key: string, proposal: Proposal | undefined, id: string): Part | "offer" => {
    if (proposal === undefined) return fixed(key, false, "no_command");
    if (machine.instances.some((i) => i.id === id)) return fixed(key, false, "id_taken");
    const made = instanceEntry({ ...proposal, id });
    if (!made.ok)
      return fixed(key, false, made.needs.includes("exec") ? "no_command" : "needs_home");
    byRow.set(key, {
      id,
      label: proposal.label,
      entry: made.entry,
      ...(proposal.t3 === undefined ? {} : { modelFrom: proposal.t3.modelFrom }),
    });
    return "offer";
  };

  // A home the person's environment selects (CODEX_HOME, CLAUDE_CONFIG_DIR) is one they use.
  const selected = (view: HomeView): boolean => {
    const named = envValue(env, view.home.variable, platform);
    return named !== undefined && samePath(platform, named, view.home.home);
  };
  const byName = (view: HomeView): boolean =>
    view.home.proposed === true &&
    !selected(view) &&
    view.state === "not_registered" &&
    view.sha256 === null &&
    view.home.hosts.length === 0 &&
    detection.homes.some(
      (h) => h.source === "home" && h.suffix !== "" && samePath(platform, h.path, view.home.home),
    ) &&
    !detection.proposals.some(
      (p) =>
        p.source === "wrapper" &&
        p.configHome !== undefined &&
        samePath(platform, p.configHome, view.home.home),
    );

  for (const item of plan) {
    const { view } = item;
    const { home } = view;
    const key = JSON.stringify([home.app, home.home]);
    items.set(key, item);
    let open: Part | "offer" | undefined;
    // The home's one label: the one machine.toml keeps for it, else the one its offer would write.
    let label = appLabel(home.app);
    if (home.app !== "claude-desktop") {
      const target = TARGET[home.app];
      const owner = machine.instances.find(
        (i) =>
          i.enabled &&
          i.target === target &&
          samePath(platform, instanceHome(i, userHome, platform)?.path ?? "", home.home),
      );
      const proposal = detection.proposals.find(
        (p) =>
          p.target === target &&
          p.configHome !== undefined &&
          samePath(platform, p.configHome, home.home),
      );
      label = owner?.label ?? proposal?.label ?? label;
      open = owner !== undefined ? ownedPart(key, owner) : offerPart(key, proposal, home.instance);
    }
    out.push({
      key,
      app: home.app,
      label,
      home: shown(home.home),
      also: home.hosts,
      ...(byName(view) ? { byName: true as const } : {}),
      ...(open === undefined ? {} : { open }),
      tools: toolsPart(host, space, item, answerOf(item), shown),
    });
  }

  // T3 Code: one row per provider instance its settings turn on. Its tools are the homes' above.
  const t3 = detection.proposals.find((p) => p.target === "t3");
  const settings = t3 === undefined ? undefined : t3SettingsOf({ platform, userHome, env });
  for (const proposal of settings === undefined || t3 === undefined
    ? []
    : t3Proposals(settings, t3, platform)) {
    const provider = proposal.t3?.providerInstance;
    const key = JSON.stringify(["t3", provider ?? proposal.id]);
    const owner = machine.instances.find(
      (i) => i.target === "t3" && i.t3?.providerInstance === provider,
    );
    out.push({
      key,
      app: "t3",
      label: owner?.label ?? proposal.label,
      home: null,
      also: [],
      open: owner !== undefined ? ownedPart(key, owner) : offerPart(key, proposal, proposal.id),
    });
  }

  const view: AppsView = {
    space,
    rows: out.map(({ open, ...row }): AppRow => {
      if (open !== "offer") return { ...row, ...(open === undefined ? {} : { open }) };
      const offer = byRow.get(row.key);
      if (offer === undefined) return row;
      return {
        ...row,
        open: {
          on: false,
          change: "add",
          file: configFile,
          detail: blockOf(offer.entry).map((line) => `+ ${line}`),
          plan: digest([row.key, "add", [...offer.entry]]),
        },
      };
    }),
    ...(views.some((v) => v.refusal === "record_unreadable")
      ? { record: shown(recordFile(host.stateDir)) }
      : {}),
  };
  return { view, input, items, offers: byRow, owners };
}

/** Setup's refusals of a file it cannot read as it is now, which the page says as one. */
const UNREADABLE = new Set<string>([
  "unreadable",
  "too_large",
  "encoding",
  "invalid_file",
  "duplicate_key",
  "wrong_type",
  "unsupported_layout",
]);

/**
 * The tools switch of a home, from its one answer (toolsOf): it shows on exactly while the tools
 * start, turns on only as the answer offers, and turns off whenever the access may be live. A
 * home that shows off with its access live (its entry gone, its program gone) carries that turning
 * off as `off`, beside the switch.
 */
function toolsPart(
  host: AgentAppsHost,
  space: string,
  { view, change, several }: Planned,
  answer: ToolsAnswer,
  shown: (path: string) => string,
): Part {
  const file = shown(view.home.file);
  const plan = (word: string) => digest([word, planToken(space, [{ view, change }])]);
  const recorded = view.record?.space;
  const why =
    answer.why !== undefined && UNREADABLE.has(answer.why)
      ? "file_unreadable"
      : (answer.why ?? (several === true && answer.on === "add" ? "several" : undefined));
  const base = {
    on: answer.status === "on",
    ...(why === undefined ? {} : { why }),
    file,
    ...(recorded === undefined
      ? {}
      : { space: { id: recorded, name: host.spaceName(recorded) ?? null } }),
  };
  // What turning it off takes out of the file: setup's own entry, never one the person changed.
  const own =
    view.entry !== undefined && (view.state === "registered" || view.state === "interrupted");
  const removing = {
    detail: own ? entryLines(view.home.app, view.entry, "-") : [],
    plan: plan("remove"),
  };
  if (base.on) {
    return answer.off
      ? { ...base, change: "remove", ...removing }
      : { ...base, change: null, detail: [], plan: plan(why ?? "on") };
  }
  const off = answer.off ? { off: removing } : {};
  if (answer.on === undefined) {
    return { ...base, change: null, detail: [], plan: plan(why ?? "off"), ...off };
  }
  const detail = typeof change === "object" ? [...change.diff] : [];
  return { ...base, change: "add", detail, plan: plan("add"), ...off };
}

const PLAN = /^[0-9a-f]{16}$/u;
const MAX_CHANGES = 64;

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

/** The switches the person turned over, each once, with the token its view showed. */
function changesOf(value: unknown): AppsChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGES) {
    throw invalid("changes", `Expected 1 to ${String(MAX_CHANGES)} changes`);
  }
  const changes = value.map((raw: unknown, i): AppsChange => {
    const path = `changes.${String(i)}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw invalid(path, "Expected a change");
    }
    const { key, part, on, plan } = raw as Record<string, unknown>;
    if (typeof key !== "string" || key === "" || key.length > 8192) {
      throw invalid(`${path}.key`, "Expected a row's key");
    }
    if (part !== "open" && part !== "tools")
      throw invalid(`${path}.part`, "Expected open or tools");
    if (typeof on !== "boolean") throw invalid(`${path}.on`, "Expected true or false");
    if (typeof plan !== "string" || !PLAN.test(plan)) {
      throw invalid(`${path}.plan`, "Expected the token the view showed");
    }
    return { key, part, on, plan };
  });
  const seen = new Set(changes.map((c) => JSON.stringify([c.key, c.part])));
  if (seen.size !== changes.length) throw invalid("changes", "Expected each switch once");
  return changes;
}

/** Setup's own failures as the bodies a person reads. */
function setupError(error: unknown): unknown {
  if (error instanceof LockBusy) {
    return new AppError({
      code: "conflict",
      message: "Another setup is changing the agent apps right now.",
      hint: "Try again when it has finished.",
      data: { retryable: true },
    });
  }
  if (error instanceof SetupStateInvalid || error instanceof SetupStateUnsafe) {
    return new AppError({
      code: "invalid_input",
      message: `${error.message}, so nothing was changed.`,
      hint: "Run: ttasks doctor",
    });
  }
  return error;
}

const reasonOf = (error: unknown): string => (error instanceof AppError ? error.code : "internal");

/** The key of an entry the service refused (its first issue, `entries.0.label`): `label`. */
function fieldOf(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const issues = (error.data as { issues?: { path?: unknown }[] } | undefined)?.issues;
  const path = issues?.[0]?.path;
  return typeof path === "string" ? /^entries\.\d+\.([a-z_]+)$/u.exec(path)?.[1] : undefined;
}

/**
 * The person's environment as Open's agents get it, brought up to date first: on Linux and macOS a
 * service started at sign-in lacks what the person's profile adds to PATH until their login shell
 * has been read once.
 */
export async function personEnv(source: Pick<EnvironmentSource, "prepare" | "base">): Promise<Env> {
  await source.prepare();
  return (await source.base()).env;
}

async function applyChanges(host: AgentAppsHost, params: JsonObject): Promise<unknown> {
  const space = spaceOf(params, host);
  const changes = changesOf(params["changes"]);
  return withSetupLock(host.stateDir, async () => {
    const instances = instanceVerbs(host.instances);
    const homes = agentHomeVerbs(host.homes);
    const verb = (name: string): Verb => {
      const found = (name.startsWith("instances/") ? instances : homes)[name];
      if (found === undefined) throw new Error(`No verb ${name}`);
      return found;
    };
    const access = rowAccess(
      (method, input) => verb(method)(input, "ui") as Promise<Record<string, unknown>>,
    );
    const first = await look(host, space);
    const partOf = (c: AppsChange) => first.view.rows.find((r) => r.key === c.key)?.[c.part];
    // Each switch as it was shown, and only what it offered: on, off, or off beside it.
    const fits = changes.every((c) => {
      const part = partOf(c);
      if (part === undefined) return false;
      if (part.change === (c.on ? "add" : "remove") && part.plan === c.plan) return true;
      return !c.on && part.off?.plan === c.plan;
    });
    // Something changed since the person looked: nothing is written, they see it as it is now.
    if (!fits) return { applied: false, view: first.view };
    // What a run that ended midway left is finished first (it only ever takes access away); the
    // switches the person turned over, as they saw them, then apply to what is now.
    const now =
      (await settleHomes(first.input, access)).length === 0 ? first : await look(host, space);

    const outcomes: AppsOutcome[] = [];
    const done = (c: AppsChange, reason?: string): void => {
      outcomes.push({
        key: c.key,
        part: c.part,
        result: reason === undefined ? "done" : "failed",
        ...(reason === undefined ? {} : { reason }),
      });
    };

    // What Open offers first: machine.toml's entries out, then in.
    const leaving = changes.filter((c) => c.part === "open" && !c.on);
    if (leaving.length > 0) {
      try {
        const ids = leaving.map((c) => now.owners.get(c.key) ?? "");
        const result = (await verb("instances/remove")({ ids }, "ui")) as {
          outcomes?: { id: string; result: string }[];
        };
        for (const c of leaving) {
          const id = now.owners.get(c.key);
          const found = result.outcomes?.find((o) => o.id === id)?.result;
          done(c, found === "removed" || found === "missing" ? undefined : (found ?? "edited"));
        }
      } catch (error) {
        for (const c of leaving) done(c, reasonOf(error));
      }
    }
    // Each on its own, so one the service refuses is named with its field and the others go in.
    for (const c of changes.filter((change) => change.part === "open" && change.on)) {
      const offer = now.offers.get(c.key);
      if (offer === undefined) {
        done(c, "changed_meanwhile");
        continue;
      }
      try {
        await verb("instances/add")({ entries: [wireOf(offer.entry)] }, "ui");
        done(c);
      } catch (error) {
        const field = fieldOf(error);
        outcomes.push({
          key: c.key,
          part: c.part,
          result: "failed",
          reason: reasonOf(error),
          ...(field === undefined ? {} : { field }),
        });
      }
    }

    // Then each app's own entry: out, then in, each with its row in the grants table. A home that
    // fails is reported and the others still run, so the answer names every switch's outcome.
    const each = async (
      on: boolean,
      run: (item: PlanItem, c: AppsChange) => Promise<AppsOutcome | string | undefined>,
    ) => {
      for (const c of changes.filter((change) => change.part === "tools" && change.on === on)) {
        const item = now.items.get(c.key);
        if (item === undefined) {
          done(c, "changed_meanwhile");
          continue;
        }
        try {
          const ran = await run(item, c);
          if (typeof ran === "object") outcomes.push(ran);
          else done(c, ran);
        } catch (error) {
          done(c, reasonOf(error));
        }
      }
    };
    // Off is off once the access is taken back; an entry that stayed is said with it.
    await each(false, async (item, c) => {
      const outcome = await removeHome(now.input, item.view, access);
      if (outcome.access !== "off") return "revoke_failed";
      if (outcome.kept === undefined) return undefined;
      const reason = outcome.reason ?? outcome.result;
      return { key: c.key, part: "tools", result: "done", reason, kept: true };
    });
    // On is on once the home has its access: a new entry, or one in place whose access went.
    await each(true, async (item, c) => {
      const outcome = await applyHome(now.input, item.view, space, access, item.change);
      if (outcome.access === "on") return undefined;
      const reason = outcome.reason ?? outcome.result;
      if (outcome.access !== "unknown" || reason === "revoke_failed") return reason;
      return { key: c.key, part: "tools", result: "failed", reason, unconfirmed: true };
    });
    return { applied: true, outcomes, view: (await look(host, space)).view };
  });
}

/** The page's two calls. Each refuses every caller but the person before it reads anything. */
export function agentAppVerbs(host: AgentAppsHost): {
  readonly view: Verb;
  readonly apply: Verb;
} {
  return {
    view: async (params, cls) => {
      userOnly(cls);
      try {
        return (await look(host, spaceOf(params, host))).view;
      } catch (error) {
        throw setupError(error);
      }
    },
    apply: async (params, cls) => {
      userOnly(cls);
      try {
        return await applyChanges(host, params);
      } catch (error) {
        throw setupError(error);
      }
    },
  };
}
