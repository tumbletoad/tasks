// The e2e tests' `test`: Playwright's, with a worker-scoped world (world.ts) around the real
// service and the page built once per run (global-setup.ts).
import { test as base } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeT3 } from "../../packages/testkit/src/fake-t3.ts";
import { startWorld, type World } from "./world.ts";

/** A world whose T3 Code instance has a fake T3 server, which the test steers. */
export interface T3World {
  readonly world: World;
  readonly fake: FakeT3;
}

/** The design scale's open tasks (A5 3.25, A1): the bulk world's Mira holds this many more. */
export const BULK_TASKS = 5_000;

/** The finished world's Mira: thousands finished in one month, some checked off, some dropped. */
export const FINISHED_TASKS = { done: 3_000, pending: 30, dropped: 5 } as const;

export function built(): string {
  const ui = process.env["E2E_UI_BUILD"];
  if (ui === undefined) throw new Error("global-setup.ts did not build the page");
  return ui;
}

export const test = base.extend<
  { copies: World },
  {
    world: World;
    bulk: World;
    finished: World;
    runs: World;
    restartable: World;
    large: World;
    monitored: World;
    t3: T3World;
  }
>({
  // A test's routes end with the test. One that still passes a request on when its test ends (the
  // page asks again on a timer) is rejected then, and that failed whichever test ran next.
  context: async ({ context }, use) => {
    await use(context);
    for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.unrouteAll({ behavior: "ignoreErrors" });
  },
  // One started only by the tests that use it: the fake `ttam` as the Agent Monitor, and the fake
  // Codex, so a task can have a background run beside an agent in a terminal.
  monitored: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { monitor: true, runs: true });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
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
  // A world of its own for the tests that stop and start its service, so no other test meets it.
  restartable: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built());
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // A fourth, started only by the tests that use it: the fake Codex can run tasks there too.
  runs: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { runs: true });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // A fifth, started only by the tests that use it: Mira grown to the size of a space in use.
  large: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { large: true });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // A world with a T3 Code instance whose T3 is a fake server in this worker, started only by the
  // tests that use it. Its T3 runs and is not paired.
  t3: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const folder = mkdtempSync(join(tmpdir(), "ttasks-e2e-t3-"));
      const fake = await FakeT3.start(join(folder, "t3home"));
      try {
        const world = await startWorld(built(), { t3: fake.home });
        try {
          await use({ world, fake });
        } finally {
          await world.close();
        }
      } finally {
        await fake.stop();
        rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
  // A second world, started only by the tests that use it: Mira with 5,000 more open tasks.
  bulk: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { bulk: BULK_TASKS });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
  // A third, started only by the tests that use it: Mira with thousands of finished tasks.
  finished: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built(), { finished: FINISHED_TASKS });
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
  world: [
    // Playwright reads the fixtures a function takes from its first parameter: none here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = await startWorld(built());
      try {
        await use(world);
      } finally {
        await world.close();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
});
