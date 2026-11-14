// The backends the launch tests run against: in memory, and the space database through the testkit
// fixture (in this thread, or through a storage worker). Every space lives in a temporary folder of
// its own, removed by its full name.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLaunchSpace,
  openLaunchSpaceInWorker,
  type LaunchSpace,
  type WorkerLaunchSpace,
} from "@tasks/testkit";
import { SpaceExecutionStore } from "../src/space-store.ts";
import type { ExecutionStore } from "../src/store.ts";
import type { ContractBackend } from "./execution-store-contract.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";

export const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";

/** A temporary folder of its own, and its removal by that full name. */
export function tempFolder(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), "tasks-launch-"));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function memoryBackend(): ContractBackend {
  let time = Date.UTC(2026, 10, 13, 9, 0, 0);
  const durable = new MemoryDurable(() => (time += 1));
  const backend: ContractBackend = {
    store: new MemoryExecutionStore(durable),
    machine: MACHINE,
    task: () => Promise.resolve(randomId("t")),
    place: () => Promise.resolve(randomId("pl")),
    advance: (ms) => {
      time += ms;
    },
    restart: () => Promise.resolve(new MemoryExecutionStore(durable)),
    close: () => Promise.resolve(),
  };
  return backend;
}

/** The v1 store on a space's writer. */
export function spaceStore(space: LaunchSpace | WorkerLaunchSpace): ExecutionStore {
  return new SpaceExecutionStore({
    writer: space.writer,
    spaceId: space.spaceId,
    credential: space.credential,
  });
}

export async function spaceBackend(
  options: { now?: () => number } = {},
): Promise<ContractBackend & { space: LaunchSpace }> {
  const folder = tempFolder();
  let space: LaunchSpace;
  try {
    space = await openLaunchSpace(folder.path, options);
  } catch (error) {
    folder.remove();
    throw error;
  }
  return {
    space,
    store: spaceStore(space),
    machine: space.machine,
    task: () => space.task(),
    place: () => space.place(),
    advance: (ms) => {
      space.advance(ms);
    },
    restart: () => {
      space.restart();
      return Promise.resolve(spaceStore(space));
    },
    close: () => {
      try {
        space.close();
      } finally {
        folder.remove();
      }
      return Promise.resolve();
    },
  };
}

export async function workerSpace(): Promise<{
  space: WorkerLaunchSpace;
  close: () => Promise<void>;
}> {
  const folder = tempFolder();
  let space: WorkerLaunchSpace;
  try {
    space = await openLaunchSpaceInWorker(folder.path);
  } catch (error) {
    folder.remove();
    throw error;
  }
  return {
    space,
    close: async () => {
      try {
        await space.close();
      } finally {
        folder.remove();
      }
    },
  };
}
