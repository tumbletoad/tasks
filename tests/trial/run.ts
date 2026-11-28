// pnpm trial: step 1's trial of the library (README.md). For each agent it makes a fresh world,
// runs the twenty scripted tasks in order as background runs, task 15 as two runs at once, checks
// what each left, and writes one JSON line per run and a summary table. Rule (a) runs task 1 again
// in fresh worlds until it has ten runs.
//
//   pnpm trial --stand-in                                the run tests' stand-in agents
//   pnpm trial --instances <file.toml> --agents <id,…>   agent instances the person gives
//     [--tasks N] [--repeats N] [--only 1,2,9] [--out DIR] [--keep]
//
// It writes only in its own temporary folders and in --out. It never writes into an agent's home:
// the instances' programs keep their own, and the service looks for agent apps in an empty folder.
import "../../packages/bridge/src/safe-exit.ts";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMain } from "../../packages/cli/test/cli-harness.ts";
import { parseToml } from "../../packages/service/src/config/toml.ts";
import { instanceToml } from "../../packages/service/test/harness.ts";
import { DATE_TASKS, TASKS, type TrialTask } from "./tasks.ts";
import {
  callLine,
  callsOf,
  historyBytes,
  livePages,
  makeWorld,
  pageEdits,
  projectBrief,
  usageOf,
  type Json,
  type World,
} from "./world.ts";

const USAGE =
  "usage: pnpm trial --stand-in | --instances <file.toml> --agents <id,...> " +
  "[--tasks N] [--repeats N] [--only 1,2,9] [--out DIR] [--keep]";

const STAND_IN = fileURLToPath(new URL("./stand-in.ts", import.meta.url));

interface Options {
  readonly agents: readonly string[];
  readonly instances: string;
  readonly standIn: boolean;
  readonly seedTasks: number;
  readonly repeats: number;
  readonly only: ReadonlySet<string> | undefined;
  readonly out: string;
  readonly keep: boolean;
}

function parse(): Options {
  const { values } = parseArgs({
    options: {
      "stand-in": { type: "boolean", default: false },
      instances: { type: "string" },
      agents: { type: "string" },
      tasks: { type: "string", default: "400" },
      repeats: { type: "string", default: "3" },
      only: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
    },
    strict: true,
  });
  const standIn = values["stand-in"];
  if (standIn === (values.instances !== undefined)) throw new Error(USAGE);
  const agents = standIn ? ["stand-in"] : (values.agents ?? "").split(",").filter((a) => a !== "");
  if (agents.length === 0) throw new Error(USAGE);
  const seedTasks = Number(values.tasks);
  const repeats = Number(values.repeats);
  if (!Number.isInteger(seedTasks) || seedTasks < 1 || !Number.isInteger(repeats) || repeats < 0) {
    throw new Error(USAGE);
  }
  const instances = standIn ? "" : readFileSync(values.instances ?? "", "utf8");
  if (!standIn) contained(instances);
  return {
    agents,
    instances,
    standIn,
    seedTasks,
    repeats,
    only: values.only === undefined ? undefined : new Set(values.only.split(",")),
    out: values.out ?? mkdtempSync(join(tmpdir(), "ttasks-trial-out-")),
    keep: values.keep,
  };
}

/**
 * Refuses an instance that can reach past the world. A real agent runs in the person's own
 * profile, with their own instructions and memory: with write access it has edited a repository
 * of theirs, and Codex's app connectors have searched the account's connected services. The tasks
 * need only the TTasks tools, which a read-only run without apps still has.
 */
function contained(text: string): void {
  const parsed = parseToml(text);
  if (!parsed.ok) throw new Error(`trial: the instances file is not TOML (${parsed.problem.code})`);
  const tables = parsed.doc["instance"];
  for (const table of Array.isArray(tables) ? (tables as Record<string, unknown>[]) : []) {
    const id = String(table["id"]);
    if (table["run_permission"] !== "read-only") {
      throw new Error(
        `trial: instance ${id} needs run_permission = "read-only": with more, ` +
          "an agent can change the person's own files outside the world",
      );
    }
    const prefix = Array.isArray(table["args_prefix"]) ? (table["args_prefix"] as unknown[]) : [];
    const appsOff = prefix.some((arg, i) => arg === "--disable" && prefix[i + 1] === "apps");
    if (table["target"] === "codex-cli" && !appsOff) {
      throw new Error(
        `trial: instance ${id} needs "--disable", "apps" in args_prefix: Codex's app ` +
          "connectors reach the account's connected services",
      );
    }
  }
}

/** The stand-in agents: one instance for each of two runs at once, reading the script `plan`. */
const standInToml = (plan: string): string =>
  (["a", "b"] as const)
    .map((slot) =>
      instanceToml({
        id: slot === "a" ? "stand-in" : "stand-in-b",
        target: "claude-cli",
        label: "Stand-in agent",
        exec: process.execPath,
        args_prefix: [STAND_IN],
        env: { TRIAL_STAND_IN: plan, TRIAL_STAND_IN_SLOT: slot },
      }),
    )
    .join("");

interface RunLine {
  readonly agent: string;
  readonly world: string;
  readonly task: string;
  readonly counts: readonly string[];
  readonly run: string;
  readonly state: string;
  readonly reason: string | null;
  readonly seconds: number;
  readonly tokens: {
    readonly input: number | null;
    readonly cached: number | null;
    readonly output: number | null;
    readonly cost_usd: number | null;
  };
  readonly calls: Readonly<Record<string, number>>;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly pass: boolean;
}

interface Trial {
  readonly options: Options;
  readonly lines: RunLine[];
  readonly worlds: { agent: string; world: string; library: Json }[];
}

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** One background run of `task` with `instance`, to its end, as `ttasks run --wait` gives it. */
async function backgroundRun(world: World, task: TrialTask, instance: string): Promise<Json> {
  const ref = world.tasks.get(task.n)?.ref ?? "";
  const ran = await runMain(["run", ref, "--instance", instance, "--wait", "--json", "-"], {
    home: world.home,
    tty: true,
    stdin: task.request,
  });
  try {
    return JSON.parse(ran.stdout) as Json;
  } catch {
    return {
      state: "not_started",
      reason: ran.stderr.trim().slice(0, 200) || `exit ${String(ran.code)}`,
    };
  }
}

/** Runs `tasks` in order in `world`, the runs of one number at once. */
async function runTasks(
  trial: Trial,
  world: World,
  label: { agent: string; world: string },
  tasks: readonly TrialTask[],
  planFile: string,
): Promise<void> {
  const groups = new Map<string, TrialTask[]>();
  for (const task of tasks) {
    const key = task.n.replace(/[ab]$/u, "");
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  for (const group of groups.values()) {
    const base = await world.asOf();
    const next = world.nextRef();
    const plan: Record<string, unknown> = {};
    const scripted = group.map((task, i) => {
      const own = world.tasks.get(task.n);
      if (own === undefined) throw new Error(`no task ${task.n} in the world`);
      const calls = task.standIn({ world, task: own, base, next });
      plan[i === 0 ? "a" : "b"] = { calls, home: world.home };
      return calls.map((c) => callLine(c.name, c.arguments));
    });
    writeFileSync(planFile, JSON.stringify(plan));
    const started = Date.now();
    const instances = group.map((_, i) =>
      trial.options.standIn ? (i === 0 ? "stand-in" : "stand-in-b") : label.agent,
    );
    const results = await Promise.all(
      group.map((task, i) => backgroundRun(world, task, instances[i] ?? "")),
    );
    const ended = Date.now();
    group.forEach((task, i) => {
      const own = world.tasks.get(task.n);
      const result = results[i] ?? {};
      const run = typeof result["id"] === "string" ? result["id"] : "";
      // The stand-in makes its calls itself, past the exchange it replays: its script is what it
      // called. A real agent's calls are in its own output.
      const calls = trial.options.standIn ? (scripted[i] ?? []) : callsOf(world, run);
      const checks = own === undefined ? {} : task.check({ world, task: own, calls });
      const usage = run === "" ? {} : usageOf(world, run);
      const tally: Record<string, number> = {};
      for (const c of calls) tally[c.tool] = (tally[c.tool] ?? 0) + 1;
      const line: RunLine = {
        ...label,
        task: task.n,
        counts: task.counts,
        run,
        state: typeof result["state"] === "string" ? result["state"] : "unknown",
        reason: typeof result["reason"] === "string" ? result["reason"] : null,
        seconds: Math.round((ended - started) / 100) / 10,
        tokens: {
          input: num(usage["input_tokens"]),
          cached: num(usage["cached_input_tokens"]),
          output: num(usage["output_tokens"]),
          cost_usd: num(usage["cost_usd"]),
        },
        calls: tally,
        checks,
        pass: result["state"] === "succeeded" && Object.values(checks).every(Boolean),
      };
      trial.lines.push(line);
      appendFileSync(join(trial.options.out, "runs.jsonl"), `${JSON.stringify(line)}\n`);
      process.stdout.write(
        `trial: ${label.agent} task ${task.n}: ${line.state}, ${line.pass ? "pass" : "FAIL"} ` +
          `${JSON.stringify(checks)}\n`,
      );
    });
  }
}

/** A world for `agent`, with `tasks` run in it. */
async function inWorld(
  trial: Trial,
  agent: string,
  name: string,
  tasks: readonly TrialTask[],
): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "ttasks-trial-"));
  const planFile = join(root, "stand-in-plan.json");
  writeFileSync(planFile, "{}");
  const world = await makeWorld(root, {
    seedTasks: trial.options.seedTasks,
    instances: trial.options.standIn ? standInToml(planFile) : trial.options.instances,
    titles: new Map(TASKS.map((t) => [t.n, t.title])),
  });
  try {
    await runTasks(trial, world, { agent, world: name }, tasks, planFile);
  } catch (error) {
    await world.stop();
    throw error;
  }
  return world;
}

const close = async (trial: Trial, world: World): Promise<void> => {
  await world.stop();
  if (!trial.options.keep)
    rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
};

/** (c): what the library holds after the twenty tasks, and a page list for the person who judges it. */
function libraryAfter(world: World, label: string, out: string): Json {
  const pages = livePages(world);
  const made = pages.filter((p) => p.createdSeq > world.setupSeq);
  const titles = new Map<string, number>();
  for (const p of pages)
    titles.set(p.title.toLowerCase(), (titles.get(p.title.toLowerCase()) ?? 0) + 1);
  const lines = [
    `# Pages after the twenty tasks: ${label}`,
    "",
    "Judge each made page and edit: needed, needless, or a duplicate of another page.",
    "",
    ...pages.flatMap((p) => [
      `## ${p.ref} ${p.title}${p.createdSeq > world.setupSeq ? " (made in the trial)" : ""}`,
      "",
      `Brief: ${p.brief === "" ? "none" : p.brief}`,
      "",
      p.body,
      "",
    ]),
  ];
  writeFileSync(join(out, `pages-${label}.md`), lines.join("\n"));
  return {
    pages_made: made.length,
    page_edits: pageEdits(world),
    history_bytes: historyBytes(world),
    same_titles: [...titles.values()].filter((n) => n > 1).length,
    trial_brief: projectBrief(world, world.projectId) !== "",
  };
}

const pct = (yes: number, of: number): string => (of === 0 ? "-" : `${String(yes)}/${String(of)}`);
const median = (values: number[]): number | undefined => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted[Math.floor((sorted.length - 1) / 2)];
};

/** The summary table, one row per agent. */
function summary(trial: Trial): string {
  const rows = [
    "| agent | runs | succeeded | checks passed | (a) applied | (a) read the area page | (b) task 9 | (c) made / edits / same titles | (c) history bytes per edit | (d) median input tokens | (d) total input tokens | (e) both stand | (f) found, searched, on a page |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const agent of trial.options.agents) {
    const lines = trial.lines.filter((l) => l.agent === agent);
    if (lines.length === 0) continue;
    const dates = lines.filter((l) => DATE_TASKS.includes(l.task));
    const nine = lines.find((l) => l.task === "9");
    const eleven = lines.find((l) => l.task === "11");
    const pair = lines.filter((l) => l.task.startsWith("15"));
    const library = trial.worlds.find((w) => w.agent === agent)?.library;
    const inputs = lines.map((l) => l.tokens.input).filter((t): t is number => t !== null);
    rows.push(
      [
        agent,
        String(lines.length),
        pct(lines.filter((l) => l.state === "succeeded").length, lines.length),
        pct(lines.filter((l) => l.pass).length, lines.length),
        pct(dates.filter((l) => l.checks["applied"] === true).length, dates.length),
        pct(dates.filter((l) => l.checks["read_area_page"] === true).length, dates.length),
        nine === undefined ? "-" : nine.pass ? "yes" : "no",
        library === undefined
          ? "-"
          : `${String(library["pages_made"])} / ${String(library["page_edits"])} / ${String(library["same_titles"])}`,
        library === undefined || Number(library["page_edits"]) === 0
          ? "-"
          : String(Math.round(Number(library["history_bytes"]) / Number(library["page_edits"]))),
        String(median(inputs) ?? "-"),
        String(inputs.reduce((s, t) => s + t, 0)),
        pair.length === 0 ? "-" : pair.every((l) => l.checks["stands"] === true) ? "yes" : "no",
        eleven === undefined
          ? "-"
          : ["found_the_rule", "searched", "put_on_a_page"]
              .map((k) => (eleven.checks[k] === true ? "yes" : "no"))
              .join(", "),
      ]
        .join(" | ")
        .replace(/^/u, "| ")
        .replace(/$/u, " |"),
    );
  }
  return rows.join("\n");
}

async function main(): Promise<number> {
  const options = parse();
  mkdirSync(options.out, { recursive: true });
  const trial: Trial = { options, lines: [], worlds: [] };
  const tasks = TASKS.filter(
    (t) => options.only === undefined || options.only.has(t.n.replace(/[ab]$/u, "")),
  );
  const repeat = TASKS.filter((t) => t.n === "1");
  for (const agent of options.agents) {
    const world = await inWorld(trial, agent, agent, tasks);
    trial.worlds.push({ agent, world: agent, library: libraryAfter(world, agent, options.out) });
    await close(trial, world);
    // Rule (a) needs ten runs: the sequence's date lines, then task 1 alone in fresh worlds.
    if (tasks.some((t) => t.n === "1")) {
      for (let r = 1; r <= options.repeats; r += 1) {
        await close(trial, await inWorld(trial, agent, `${agent}-a${String(r)}`, repeat));
      }
    }
  }
  const table = summary(trial);
  writeFileSync(join(options.out, "summary.md"), `${table}\n`);
  process.stdout.write(
    `\n${table}\n\ntrial: runs.jsonl, summary.md and the page lists are in ${options.out}\n`,
  );
  return trial.lines.every((l) => l.state === "succeeded") ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `trial: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(2);
  },
);
