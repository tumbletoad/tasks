// The e2e tests' `test`: Playwright's, with worlds (world.ts) around the real service and the page
// built once per run (global-setup.ts). A world belongs to one test file: the file's tests share
// it, and no test meets what another file's tests added, finished, trashed or archived.
import { test as base } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeT3 } from "../../packages/testkit/src/fake-t3.ts";
import { startWorld, type World, type WorldOptions } from "./world.ts";

/** A world whose T3 Code instance has a fake T3 server, which the test steers. */
export interface T3World {
  readonly world: World;
  readonly fake: FakeT3;
}

/** The design scale's open tasks: the bulk world's Mira holds this many more. */
export const BULK_TASKS = 5_000;

/** The finished world's Mira: thousands finished in one month, some checked off, some dropped. */
export const FINISHED_TASKS = { done: 3_000, pending: 30, dropped: 5 } as const;

export function built(): string {
  const ui = process.env["E2E_UI_BUILD"];
  if (ui === undefined) throw new Error("global-setup.ts did not build the page");
  return ui;
}

/**
 * The worlds of the file a worker runs now, by fixture. A file's first test that asks for one starts
 * it, and the first test of the next file closes them all. A repeat of a file is a file of its own.
 */
class FileWorlds {
  private file = "";
  private readonly held = new Map<
    string,
    { value: Promise<unknown>; close: () => Promise<void> }
  >();

  async enter(file: string): Promise<void> {
    if (file === this.file) return;
    this.file = file;
    await this.closeAll();
  }

  get<T>(key: string, start: () => Promise<T>, close: (value: T) => Promise<void>): Promise<T> {
    let held = this.held.get(key);
    if (held === undefined) {
      const value = start();
      held = { value, close: async () => close(await value) };
      this.held.set(key, held);
    }
    return held.value as Promise<T>;
  }

  async closeAll(): Promise<void> {
    const held = [...this.held.values()];
    this.held.clear();
    const closed = await Promise.allSettled(held.map((h) => h.close()));
    const failed = closed.find((c) => c.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }
}

/** The file's world of this name, started with these options the first time its file asks. */
function fileWorld(
  key: string,
  options: WorldOptions = {},
): [
  (fixtures: { ofFile: FileWorlds }, use: (world: World) => Promise<void>) => Promise<void>,
  { timeout: number },
] {
  return [
    async ({ ofFile }: { ofFile: FileWorlds }, use: (world: World) => Promise<void>) => {
      await use(
        await ofFile.get(
          key,
          () => startWorld(built(), options),
          (world) => world.close(),
        ),
      );
    },
    // Starting a world with thousands of tasks takes a while on a loaded machine.
    { timeout: 300_000 },
  ];
}

export const test = base.extend<
  {
    ofFile: FileWorlds;
    copies: World;
    world: World;
    bulk: World;
    finished: World;
    runs: World;
    restartable: World;
    large: World;
    monitored: World;
    t3: T3World;
    tree: World;
  },
  { worlds: FileWorlds }
>({
  // A test's routes end with the test. One that still passes a request on when its test ends (the
  // page asks again on a timer) is rejected then, and that failed whichever test ran next.
  context: async ({ context }, use) => {
    await use(context);
    for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.unrouteAll({ behavior: "ignoreErrors" });
  },
  worlds: [
    // Playwright reads the fixtures a function takes from its first parameter: none here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const worlds = new FileWorlds();
      try {
        await use(worlds);
      } finally {
        await worlds.closeAll();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // For every test, also one that asks for no world: the last file's worlds close before it runs.
  ofFile: [
    async ({ worlds }, use, info) => {
      await worlds.enter(`${info.file}#${String(info.repeatEachIndex)}`);
      await use(worlds);
    },
    { auto: true, timeout: 240_000 },
  ],
  world: fileWorld("world"),
  // Mira with 5,000 more open tasks.
  bulk: fileWorld("bulk", { bulk: BULK_TASKS }),
  // Mira with thousands of finished tasks.
  finished: fileWorld("finished", { finished: FINISHED_TASKS }),
  // The fake Codex can run tasks here too.
  runs: fileWorld("runs", { runs: true }),
  // For the tests that stop and start its service, so no test of the file meets that in `world`.
  restartable: fileWorld("restartable"),
  // Mira grown to the size of a space in use.
  large: fileWorld("large", { large: true }),
  // The fake `ttam` as the Agent Monitor, and the fake Codex, so a task can have a background run
  // beside an agent in a terminal.
  monitored: fileWorld("monitored", { monitor: true, runs: true }),
  // Mira's world with a space on the new storage, four levels of projects deep (tree.ts).
  tree: fileWorld("tree", { tree: true }),
  // A T3 Code instance whose T3 is a fake server in this worker. Its T3 runs and is not paired.
  t3: [
    async ({ ofFile }, use) => {
      await use(
        await ofFile.get(
          "t3",
          async () => {
            const folder = mkdtempSync(join(tmpdir(), "ttasks-e2e-t3-"));
            const fake = await FakeT3.start(join(folder, "t3home"));
            try {
              // The monitor too: the Agents page shows a task's T3 thread with its picture.
              return {
                world: await startWorld(built(), { t3: fake.home, monitor: true }),
                fake,
                folder,
              };
            } catch (error) {
              await fake.stop();
              rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
              throw error;
            }
          },
          async ({ world, fake, folder }) => {
            try {
              await world.close();
            } finally {
              await fake.stop();
              rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
          },
        ),
      );
    },
    { timeout: 240_000 },
  ],
  // A world of each test's own for the tests that close its space and open a restored copy of it:
  // each starts from the space as it was made, also when it runs again. With the fake Codex, so a
  // backup can hold a run that works.
  copies: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { runs: true });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { timeout: 240_000 },
  ],
});
