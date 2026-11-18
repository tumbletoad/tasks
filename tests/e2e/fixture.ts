// The e2e tests' `test`: Playwright's, with a worker-scoped world (world.ts) around the real
// service and the page built once per run (global-setup.ts).
import { test as base } from "@playwright/test";
import { startWorld, type World } from "./world.ts";

/** The design scale's open tasks (A5 3.25, A1): the bulk world's Mira holds this many more. */
export const BULK_TASKS = 5_000;

/** The finished world's Mira: thousands finished in one month, some checked off, some dropped. */
export const FINISHED_TASKS = { done: 3_000, pending: 30, dropped: 5 } as const;

function built(): string {
  const ui = process.env["E2E_UI_BUILD"];
  if (ui === undefined) throw new Error("global-setup.ts did not build the page");
  return ui;
}

export const test = base.extend<
  object,
  { world: World; bulk: World; finished: World; large: World }
>({
  // A fourth, started only by the tests that use it: Mira grown to the size of a space in use.
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
