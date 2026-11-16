// The M0.04 storage bench (A7 3.7). One command builds the corpora and runs R02 to R06:
//
//   pnpm exec node spikes/m0/storage/run.ts --scale <n> --out <folder> [--work <folder>]
//
// See README.md for how M0.05 runs it on each machine and what each number decides.
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { describeError, inRunFolder } from "./cleanup.ts";
import {
  generateSpace,
  sizeBreakdown,
  type SpaceInfo,
  type SpaceOptions,
  textSizes,
} from "./fixture.ts";
import { historyLayout } from "./layout.ts";
import { r02, SECONDS as R02_SECONDS } from "./r02.ts";
import { r03 } from "./r03.ts";
import { r04, SECONDS as R04_SECONDS } from "./r04.ts";
import { r05 } from "./r05.ts";
import { r06 } from "./r06.ts";
import {
  type Context,
  machine,
  type MachineRole,
  report,
  type RowResult,
  type TextProfile,
  unmet,
  writeJson,
} from "./results.ts";

const HELP = `Tasks storage bench (M0.04)

  node spikes/m0/storage/run.ts --scale <n> --out <folder> [options]

  --scale <n>         1 = full design scale and stress corpus, 0.01 = CI. Default 1.
  --out <folder>      Folder for the result files: a new or empty folder, one per run. Created
                      if missing. A folder that holds files is refused.
  --work <folder>     Existing folder in which the bench creates its temporary space folder
                      (the lab passes ~/Tasks there for R03). It is never created by the bench.
                      Default: a temporary folder inside --out, removed at the end.
  --seed <text>       Seed of the fixture generators. Default "mira".
  --text <profile>    default or heavy. heavy writes longer and more notes and log entries,
                      near A1 3.20's 80 MB. Default: default.
  --machine <role>    windows or linux: which R03 and R05 thresholds apply.
                      Default: windows on Windows, linux elsewhere.
  --r04-seconds <n>   Duration of R04. Default 300 at full scale, 3 at 1 %. A run under 300 s
                      is indicative only.
  --layout            Also measure the history table in both layouts (history-layout.json).
  --keep              Keep the temporary space folder for inspection.
  --inject-fault <p>  Test hook: fail at point p ("generate": inside the primary's generation).
  --help              Show this text.

  A row gets a verdict only when the run meets its prescribed conditions (scale 1 and the
  row's counts and durations). Any other run is marked indicative.
`;

interface Options {
  scale: number;
  out: string;
  work: string | undefined;
  seed: string;
  text: TextProfile;
  machine: MachineRole;
  r04Seconds: number | undefined;
  layout: boolean;
  keep: boolean;
  fault: "generate" | undefined;
}

function fail(message: string): never {
  console.error(`storage bench: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parse(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      scale: { type: "string", default: "1" },
      out: { type: "string" },
      work: { type: "string" },
      seed: { type: "string", default: "mira" },
      text: { type: "string", default: "default" },
      machine: { type: "string" },
      "r04-seconds": { type: "string" },
      layout: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      "inject-fault": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const scale = Number(values.scale);
  if (!(scale > 0 && scale <= 1)) fail("--scale must be a number above 0 and at most 1");
  if (values.out === undefined) fail("--out is required");
  // A rerun into a used folder would leave the earlier run's files, complete: true included,
  // beside a failed run's partial ones. So every run gets a new or empty folder.
  const out = statSync(values.out, { throwIfNoEntry: false });
  if (out !== undefined && !out.isDirectory()) fail("--out must name a folder");
  if (out !== undefined && readdirSync(values.out).length > 0) {
    fail("--out must be a new or empty folder. It holds files already: use a new folder per run.");
  }
  const role = values.machine ?? (process.platform === "win32" ? "windows" : "linux");
  if (role !== "windows" && role !== "linux") fail("--machine must be windows or linux");
  const text = values.text;
  if (text !== "default" && text !== "heavy") fail("--text must be default or heavy");
  const fault = values["inject-fault"];
  if (fault !== undefined && fault !== "generate") fail("--inject-fault knows only generate");
  let r04Seconds: number | undefined;
  if (values["r04-seconds"] !== undefined) {
    r04Seconds = Number(values["r04-seconds"]);
    if (!(Number.isInteger(r04Seconds) && r04Seconds > 0))
      fail("--r04-seconds must be a positive integer");
  }
  if (
    values.work !== undefined &&
    statSync(values.work, { throwIfNoEntry: false })?.isDirectory() !== true
  ) {
    fail("--work must name an existing folder. The bench never creates it.");
  }
  return {
    scale,
    out: values.out,
    work: values.work,
    seed: values.seed,
    text,
    machine: role,
    r04Seconds,
    layout: values.layout,
    keep: values.keep,
    fault,
  };
}

const scaled = (n: number, scale: number, min = 1): number => Math.max(min, Math.round(n * scale));
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

interface Corpus {
  role: "primary" | "second" | "stress";
  dir: string;
  options: SpaceOptions;
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const started = performance.now();
  mkdirSync(o.out, { recursive: true });
  const runDir = mkdtempSync(join(o.work ?? o.out, "tasks-storage-bench-"));
  const ctx: Context = {
    scale: o.scale,
    seed: o.seed,
    text: o.text,
    machine: machine(o.machine),
    out: o.out,
  };
  console.log(
    `Tasks storage bench (M0.04): scale ${String(o.scale)}, seed ${o.seed}, text ${o.text}, ` +
      `machine ${o.machine}, ${ctx.machine.platform}, Node ${ctx.machine.node}, SQLite ${ctx.machine.sqlite}`,
  );
  await inRunFolder(runDir, o.keep, async () => {
    // Part 1: the corpora (A1 3.20). The primary space is the design-scale space with its history,
    // about 600 MB at full scale. The second design-scale space and the stress corpus hold rows
    // only: the reader workers share the second space, and R05 also searches the stress corpus.
    const s = o.scale;
    const corpora: Corpus[] = [
      {
        role: "primary",
        dir: "mira",
        options: {
          seed: `${o.seed}/primary`,
          open: scaled(5000, s),
          completed: scaled(50_000, s),
          history: true,
          name: "Mira",
          prefix: "M",
          text: o.text,
          ...(o.fault === "generate" ? { faultAt: 0 } : {}),
        },
      },
      {
        role: "second",
        dir: "studio",
        options: {
          seed: `${o.seed}/second`,
          open: scaled(5000, s),
          completed: scaled(50_000, s),
          history: false,
          name: "Studio",
          prefix: "S",
          text: o.text,
        },
      },
      {
        role: "stress",
        dir: "stress",
        options: {
          seed: `${o.seed}/stress`,
          open: scaled(10_000, s),
          completed: scaled(100_000, s),
          history: false,
          name: "Mira",
          prefix: "M",
          text: o.text,
        },
      },
    ];
    const spaces: (SpaceInfo & {
      role: string;
      history: boolean;
      text: ReturnType<typeof textSizes>;
    })[] = [];
    const paths: string[] = [];
    for (const c of corpora) {
      mkdirSync(join(runDir, c.dir));
      const path = join(runDir, c.dir, "space.db");
      const info = generateSpace(path, c.options);
      // Count, median, p95 and total bytes per kind of text, so the profiles can be compared.
      spaces.push({ ...info, role: c.role, history: c.options.history, text: textSizes(path) });
      paths.push(path);
      console.log(
        `corpus ${c.role}: ${String(info.open)} open + ${String(info.completed)} completed tasks, ` +
          `${String(info.commits)} commits, ${mb(info.bytes)}, ${(info.ms / 1000).toFixed(1)} s`,
      );
    }
    const [primary, second, stress] = paths as [string, string, string];
    writeJson(join(o.out, "corpus.json"), {
      complete: true,
      scale: o.scale,
      seed: o.seed,
      textProfile: o.text,
      machine: ctx.machine,
      spaces,
      // Measured against the estimate of A1 3.20 (tasks 110, notes and log 80, history 250, search 150 MB).
      primaryBreakdown: sizeBreakdown(primary),
    });

    // Part 2: the rows, in an order that keeps each one's input defined: R02's backup sees the
    // fresh corpus, and R05 adds the trigram index last before the projection.
    const results: RowResult[] = [];
    const run = async (result: RowResult | Promise<RowResult>): Promise<void> => {
      const r = await result;
      report(ctx, r);
      results.push(r);
    };
    mkdirSync(join(runDir, "mira", "backups"));
    await run(
      r02(ctx, {
        primary,
        second,
        backupTarget: join(runDir, "mira", "backups", "space-backup.db"),
        seconds: o.scale === 1 ? R02_SECONDS : 2,
      }),
    );
    await run(r03(ctx, { primary, patches: scaled(1000, s, 50) }));
    await run(
      r04(ctx, {
        primary,
        writers: 10,
        seconds: o.r04Seconds ?? (o.scale === 1 ? R04_SECONDS : scaled(R04_SECONDS, s, 3)),
      }),
    );
    await run(r05(ctx, { primary, stress, queries: scaled(1000, s, 50) }));
    await run(r06(ctx, { primary, spaceDir: join(runDir, "mira") }));

    // Part 3, on request: the history table in both layouts, from the generated rows only. It
    // runs last, so its reads and writes cannot warm or disturb any timed row.
    if (o.layout) {
      const lastSeq = (spaces[0] as SpaceInfo).lastSeq;
      const layout = historyLayout(primary, lastSeq, runDir);
      writeJson(join(o.out, "history-layout.json"), {
        complete: true,
        scale: o.scale,
        seed: o.seed,
        textProfile: o.text,
        machine: ctx.machine,
        ...layout,
      });
      console.log(
        `history layout: changes WITHOUT ROWID ${mb(layout.withoutRowid.totalBytes)} ` +
          `(${String(layout.withoutRowid.table.overflowPages)} overflow pages), ` +
          `with rowid ${mb(layout.rowid.totalBytes)} (${String(layout.rowid.table.overflowPages)} overflow pages)`,
      );
    }

    const totalMs = Math.round(performance.now() - started);
    writeJson(join(o.out, "summary.json"), {
      complete: true,
      scale: o.scale,
      seed: o.seed,
      textProfile: o.text,
      machine: ctx.machine,
      totalMs,
      rows: results.map((r) => ({
        row: r.row,
        title: r.title,
        threshold: r.threshold,
        judged: r.judged,
        indicative: !r.judged,
        unmet: unmet(r),
        pass: r.pass,
        p50: r.latency.p50,
        p95: r.latency.p95,
        p99: r.latency.p99,
      })),
    });
    console.log(`done in ${(totalMs / 1000).toFixed(1)} s, results in --out`);
  });
  if (o.keep) console.log(`--keep: the temporary space folder was kept: ${runDir}`);
}

main().catch((error: unknown) => {
  console.error(`storage bench failed: ${describeError(error)}`);
  process.exitCode = 1;
});
