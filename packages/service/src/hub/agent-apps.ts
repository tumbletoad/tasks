// The page's agent apps (Settings, and the first start): what was found on this computer, and per
// app and home two switches, each the person's own act when they press Apply:
//
//   open   "Open tasks in this app": the home's [[instance]] in machine.toml (instances.ts), which
//          Open's tiles start the agent with
//   tools  "Give this app the Tasks tools": the app's own entry for Tasks in that home
//          (setup/agents.ts), with its agent-home row (agent-homes.ts)
//
//   view   every row and switch as it stands, each switch with what turning it over writes or
//          takes out, and a token of exactly that
//   apply  the switches the person turned over, each with the token its view showed
//
// The engine is the command line's own: the same detection, the same homes, the same refusals and
// the same setup lock, so a page and `tasks setup agents` never change a home at once. It runs here,
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
import { MCP_SERVER_KEY } from "@tasks/brand";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import {
  detect,
  instanceEntry,
  instanceHome,
  nodeDetectHost,
  shellLine,
  type Env,
  type EnvironmentSource,
  type Instance,
  type Proposal,
} from "@tasks/launch";
import { isId } from "@tasks/storage";
import { loadMachineConfig, MACHINE_TOML } from "../config/machine-toml.ts";
import type { ConnectionClass, Grant } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import {
  appLabel,
  applyWithRow,
  blockOf,
  distinctLabels,
  handRemoval,
  LockBusy,
  planOf,
  planToken,
  removeHome,
  runCommand,
  samePath,
  SERVERS_KEY,
  SetupStateInvalid,
  SetupStateUnsafe,
  survey,
  t3Proposals,
  t3SettingsOf,
  wireOf,
  withSetupLock,
  type AgentApp,
  type Change,
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
  /** The install's root, and the stable command in it that every entry runs. */
  readonly root: string;
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
 * `not_installed` (Tasks's command is not where the entry would run it), `edited`, `missing`,
 * `interrupted`, `other_space`, `several` (one of several Claude Desktop files: the person picks), or
 * one of setup's refusals.
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
  /** Exactly what changes: the command that runs, the lines that are written or taken out. */
  readonly detail: readonly string[];
  /** A token of this switch as shown: apply goes on only with the same one. */
  readonly plan: string;
  /** tools: the space the entry names, when it names one. */
  readonly space?: { readonly id: string; readonly name: string | null };
}

export interface AppRow {
  readonly key: string;
  readonly app: AgentApp | "t3";
  readonly label: string;
  /** The home, shown with `~`; null for T3 Code, whose instances are in its own settings. */
  readonly home: string | null;
  /** Other apps that read this home's tools: the Codex app, T3 Code. */
  readonly also: readonly string[];
  readonly open?: Part;
  readonly tools?: Part;
}

export interface AppsView {
  /** The space a new entry names: the tab's. */
  readonly space: string;
  readonly rows: readonly AppRow[];
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
      message: "Only the user can change this computer's agent apps.",
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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

/** The app's command, its variables first, as the person would type it. */
function commandText(platform: NodeJS.Platform, argv: readonly string[], set = {}): string {
  return shellLine(platform, argv, set) ?? argv.join(" ");
}

function toolsAdd(platform: NodeJS.Platform, change: Change): string[] {
  return change.writer === "edit"
    ? [...change.diff]
    : [`$ ${commandText(platform, [...change.exec, ...change.args], change.set)}`, ...change.diff];
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
  const installed = isFolder(host.root) && isFile(host.tasks);
  const views = userHome === "" ? [] : await survey(input);
  // Claude Desktop with several settings files (a Windows app installed twice over the years): the
  // engine changes none of them on its own, and here the person picks one with its switch. The
  // grants table keeps one home per instance, so turning one on turns the others off (apps.ts).
  const plan = planOf(input, views, space).map((item): Planned =>
    item.change === "ambiguous"
      ? { view: item.view, change: planOf(input, [item.view], space)[0]?.change, several: true }
      : item,
  );
  const written = readInstancesRecord(host.stateDir);
  const configFile = shown(pathOf(platform).join(host.configDir, MACHINE_TOML));

  const items = new Map<string, PlanItem>();
  const offers: Offer[] = [];
  /** Each offer's row and home, which tell two offers of one app apart. */
  const offerRows = new Map<string, string>();
  const offerHomes = new Map<string, string>();
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
  const offerPart = (
    key: string,
    proposal: Proposal | undefined,
    id: string,
    home?: string,
  ): Part | "offer" => {
    if (proposal === undefined) return fixed(key, false, "no_command");
    if (machine.instances.some((i) => i.id === id)) return fixed(key, false, "id_taken");
    const made = instanceEntry({ ...proposal, id });
    if (!made.ok)
      return fixed(key, false, made.needs.includes("exec") ? "no_command" : "needs_home");
    offers.push({
      id,
      label: proposal.label,
      entry: made.entry,
      ...(proposal.t3 === undefined ? {} : { modelFrom: proposal.t3.modelFrom }),
    });
    offerRows.set(id, key);
    if (home !== undefined) offerHomes.set(id, home);
    return "offer";
  };

  for (const item of plan) {
    const { view } = item;
    const { home } = view;
    const key = JSON.stringify([home.app, home.home]);
    items.set(key, item);
    let open: Part | "offer" | undefined;
    if (home.app !== "claude-desktop") {
      const target = TARGET[home.app];
      const owner = machine.instances.find(
        (i) =>
          i.enabled &&
          i.target === target &&
          samePath(platform, instanceHome(i, userHome, platform)?.path ?? "", home.home),
      );
      open =
        owner !== undefined
          ? ownedPart(key, owner)
          : offerPart(
              key,
              detection.proposals.find(
                (p) =>
                  p.target === target &&
                  p.configHome !== undefined &&
                  samePath(platform, p.configHome, home.home),
              ),
              home.instance,
              home.home,
            );
    }
    out.push({
      key,
      app: home.app,
      label: appLabel(home.app),
      home: shown(home.home),
      also: home.hosts,
      ...(open === undefined ? {} : { open }),
      tools: toolsPart(host, space, item, installed, shown),
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
      label: proposal.label,
      home: null,
      also: [],
      open: owner !== undefined ? ownedPart(key, owner) : offerPart(key, proposal, proposal.id),
    });
  }

  const labelled = distinctLabels(offers, offerHomes, platform);
  const byRow = new Map<string, Offer>();
  for (const offer of labelled) {
    const key = offerRows.get(offer.id);
    if (key !== undefined) byRow.set(key, offer);
  }
  const view: AppsView = {
    space,
    rows: out.map(({ open, ...row }): AppRow => {
      if (open !== "offer") return { ...row, ...(open === undefined ? {} : { open }) };
      // Every offer has its row: distinctLabels keeps them all.
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
  };
  return { view, input, items, offers: byRow, owners };
}

/** The tools switch of a home, from setup's own view of it. */
function toolsPart(
  host: AgentAppsHost,
  space: string,
  { view, change, several }: Planned,
  installed: boolean,
  shown: (path: string) => string,
): Part {
  const file = shown(view.home.file);
  const plan = (word: string) => digest([word, planToken(space, [{ view, change }])]);
  const fixed = (on: boolean, why: Why): Part => ({
    on,
    change: null,
    why,
    file,
    detail: [],
    plan: plan(why),
  });
  const recorded = view.record?.space;
  const named =
    recorded === undefined
      ? {}
      : { space: { id: recorded, name: host.spaceName(recorded) ?? null } };
  const removing = (why?: Why): Part => {
    const removal = handRemoval(view.home, host.platform);
    return {
      on: true,
      change: "remove",
      ...(why === undefined ? {} : { why }),
      file,
      detail:
        removal === undefined
          ? [`- ${SERVERS_KEY[view.home.app]}.${MCP_SERVER_KEY}`]
          : [`$ ${commandText(host.platform, removal.argv, removal.set)}`],
      plan: plan("remove"),
      ...named,
    };
  };
  switch (view.state) {
    case "registered":
      return removing(recorded !== undefined && recorded !== space ? "other_space" : undefined);
    case "missing":
    case "interrupted":
      return removing(view.state);
    case "edited":
      return { ...fixed(true, "edited"), ...named };
    case "refused":
      return fixed(view.refusal === "foreign_entry", view.refusal ?? "unreadable");
    case "not_registered":
      if (change === undefined || typeof change === "string") {
        return fixed(false, change ?? "unreadable");
      }
      if (!installed) return fixed(false, "not_installed");
      return {
        on: false,
        change: "add",
        ...(several === true ? { why: "several" } : {}),
        file,
        detail: toolsAdd(host.platform, change),
        plan: plan("add"),
      };
  }
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
    });
  }
  if (error instanceof SetupStateInvalid || error instanceof SetupStateUnsafe) {
    return new AppError({
      code: "invalid_input",
      message: `${error.message}, so nothing was changed.`,
      hint: "Run: tasks doctor",
    });
  }
  return error;
}

const reasonOf = (error: unknown): string => (error instanceof AppError ? error.code : "internal");

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
    const now = await look(host, space);
    const partOf = (c: AppsChange) => now.view.rows.find((r) => r.key === c.key)?.[c.part];
    const fits = changes.every((c) => {
      const part = partOf(c);
      return (
        part !== undefined && part.plan === c.plan && part.change === (c.on ? "add" : "remove")
      );
    });
    // Something changed since the person looked: nothing is written, they see it as it is now.
    if (!fits) return { applied: false, view: now.view };

    const outcomes: AppsOutcome[] = [];
    const done = (c: AppsChange, reason?: string): void => {
      outcomes.push({
        key: c.key,
        part: c.part,
        result: reason === undefined ? "done" : "failed",
        ...(reason === undefined ? {} : { reason }),
      });
    };
    const instances = instanceVerbs(host.instances);
    const homes = agentHomeVerbs(host.homes);
    const verb = (name: string): Verb => {
      const found = (name.startsWith("instances/") ? instances : homes)[name];
      if (found === undefined) throw new Error(`No verb ${name}`);
      return found;
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
    const coming = changes.filter((c) => c.part === "open" && c.on);
    if (coming.length > 0) {
      try {
        const entries = coming.map((c) => {
          const offer = now.offers.get(c.key);
          if (offer === undefined) throw new Error("An offer is missing");
          return wireOf(offer.entry);
        });
        await verb("instances/add")({ entries }, "ui");
        for (const c of coming) done(c);
      } catch (error) {
        for (const c of coming) done(c, reasonOf(error));
      }
    }

    // Then each app's own entry: out, then in, each with its row in the grants table. A home that
    // fails is reported and the others still run, so the answer names every switch's outcome.
    const rows = (method: string, input: Record<string, unknown>) =>
      verb(method)(input, "ui") as Promise<Record<string, unknown>>;
    const each = async (on: boolean, run: (item: PlanItem) => Promise<string | undefined>) => {
      for (const c of changes.filter((change) => change.part === "tools" && change.on === on)) {
        const item = now.items.get(c.key);
        if (item === undefined) {
          done(c, "changed_meanwhile");
          continue;
        }
        try {
          done(c, await run(item));
        } catch (error) {
          done(c, reasonOf(error));
        }
      }
    };
    await each(false, async (item) => {
      const outcome = await removeHome(now.input, item.view);
      if (outcome.result !== "removed") return outcome.reason ?? outcome.result;
      const { home } = item.view;
      const stale = host.homes
        .grants()
        .list("agent_home")
        .filter(
          (grant) =>
            grant.revoked_at === null &&
            grant.attrs["app"] === home.app &&
            samePath(host.platform, attr(grant, "home"), home.home),
        )
        .map((grant) => grant.grant_id);
      if (stale.length > 0) await rows("setup/home_revoke", { grants: stale });
      return undefined;
    });
    await each(true, async (item) => {
      const outcome = await applyWithRow(now.input, item, space, rows);
      return outcome.result === "applied" ? undefined : (outcome.reason ?? outcome.result);
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
