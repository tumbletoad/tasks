// A space for the launch tests (A4 5.1): a fixture space, its writer with a clock the test moves,
// and tasks and places made through the write path. Launch code never imports storage (A7 3.2),
// so its tests reach a space through this module, in the calling thread or through a storage
// worker as the service does. Fixture text only.
import { join } from "node:path";
import {
  createSpace,
  DEFAULT_DRIVER,
  openSpace,
  SpaceWriter,
  StorageWorker,
  type Credential,
  type Id,
  type MachineInfo,
  type SpaceWriterHandle,
  type WriteRequest,
  type WriteResult,
} from "@ttasks/storage";
import { checkedDriver } from "./mira.ts";

/** The machine of the launch fixture space: its authority. */
export const LAUNCH_MACHINE: MachineInfo = {
  id: "m_3q7k9d2xw8f4r6t1c5v0b2n8a7",
  name: "mira-desktop",
  os: "linux",
};

/** The writer as launch tests use it: the in-thread SpaceWriter or the worker's handle. */
type Writer = Pick<SpaceWriter, "submit"> | Pick<SpaceWriterHandle, "submit">;

interface Fixture<W> {
  folder: string;
  spaceId: Id<"sp">;
  machine: Id<"m">;
  /** The space's owner, writing from the UI: who clicks Open (A4 3.16: `created_by = user`). */
  credential: Credential;
  /** The writer now open. `restart` replaces it. */
  writer: W;
  /** A new task, through the write path. */
  task(): Promise<Id<"t">>;
  /** A new task with a place on this machine, through the write path: the place's ID. */
  place(): Promise<Id<"pl">>;
}

export interface LaunchSpace extends Fixture<SpaceWriter> {
  /** The writer's clock. */
  now(): number;
  advance(ms: number): void;
  /** Closes the writer, as a crash or a stop would, and opens a new one on the same space. */
  restart(): SpaceWriter;
  close(): void;
}

export interface WorkerLaunchSpace extends Fixture<SpaceWriterHandle> {
  restart(): Promise<SpaceWriterHandle>;
  close(): Promise<void>;
}

/** A fixture space on disk, without a writer: another process may open it (openLaunchSpaceAt). */
export interface LaunchSpaceFolder {
  folder: string;
  spaceId: Id<"sp">;
  credential: Credential;
}

/** Creates a fixture space under `parent` and opens no writer. */
export function createLaunchSpace(parent: string): Promise<LaunchSpaceFolder> {
  return created(parent);
}

async function created(parent: string): Promise<LaunchSpaceFolder> {
  const space = createSpace(await checkedDriver(), join(parent, "mira"), {
    name: "Mira",
    ownerLabel: "Mira Okafor",
    machineId: LAUNCH_MACHINE.id,
  });
  return {
    folder: space.folder,
    spaceId: space.space.spaceId,
    credential: {
      scope_id: "ui:launch-fixture",
      principal_id: space.actors.human,
      actor_kind: "human",
      machine_id: LAUNCH_MACHINE.id,
      origin: "ui",
    },
  };
}

/** Tasks and places for a fixture, made through whichever writer is open. */
function makers(
  spaceId: Id<"sp">,
  credential: Credential,
  writer: () => Writer,
): Pick<Fixture<unknown>, "task" | "place"> {
  let counter = 0;
  const submit = async (ops: WriteRequest["ops"]): Promise<WriteResult> => {
    counter += 1;
    const request: WriteRequest = {
      space_id: spaceId,
      request_id: `launch-fixture-${String(counter).padStart(8, "0")}`,
      actor: credential,
      ops,
    };
    const result = await writer().submit(request);
    if (result.status !== "applied") throw new Error(`The fixture write was ${result.status}`);
    return result;
  };
  const task = async (): Promise<Id<"t">> => {
    const result = await submit([{ kind: "task.create", title: "Fix appointment time zones" }]);
    return result.results[0]?.id as Id<"t">;
  };
  const place = async (): Promise<Id<"pl">> => {
    const id = await task();
    const result = await submit([
      { kind: "place.set", task: id, root: "work", path: "lumen/portal" },
    ]);
    return result.results[0]?.id as Id<"pl">;
  };
  return { task, place };
}

/**
 * A fixture space with its writer in this thread. The clock starts on 2026-11-13 and moves one
 * millisecond per read unless the test passes its own.
 */
export async function openLaunchSpace(
  parent: string,
  options: { now?: () => number } = {},
): Promise<LaunchSpace> {
  return openLaunchSpaceAt(await created(parent), options);
}

/** A writer in this thread on a fixture space createLaunchSpace made, maybe in another process. */
export async function openLaunchSpaceAt(
  base: LaunchSpaceFolder,
  options: { now?: () => number } = {},
): Promise<LaunchSpace> {
  const checked = await checkedDriver();
  let time = Date.UTC(2026, 10, 13, 9, 0, 0);
  const now = options.now ?? (() => (time += 1));
  const open = (): SpaceWriter =>
    SpaceWriter.open(openSpace(checked, base.folder, { role: "writer" }), {
      machine: LAUNCH_MACHINE,
      now,
    });
  const fixture: LaunchSpace = {
    ...base,
    machine: LAUNCH_MACHINE.id,
    writer: open(),
    ...makers(base.spaceId, base.credential, () => fixture.writer),
    now,
    advance: (ms) => {
      time += ms;
    },
    restart: () => {
      fixture.writer.close();
      fixture.writer = open();
      return fixture.writer;
    },
    close: () => {
      fixture.writer.close();
    },
  };
  return fixture;
}

/** A fixture space whose writer runs in a storage worker, as the service runs it. */
export async function openLaunchSpaceInWorker(parent: string): Promise<WorkerLaunchSpace> {
  const base = await created(parent);
  const worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
  const open = (): Promise<SpaceWriterHandle> =>
    worker.openSpaceWriter(base.folder, { machine: LAUNCH_MACHINE });
  let handle: SpaceWriterHandle;
  try {
    handle = await open();
  } catch (error) {
    await worker.close();
    throw error;
  }
  const fixture: WorkerLaunchSpace = {
    ...base,
    machine: LAUNCH_MACHINE.id,
    writer: handle,
    ...makers(base.spaceId, base.credential, () => fixture.writer),
    restart: async () => {
      await fixture.writer.close();
      fixture.writer = await open();
      return fixture.writer;
    },
    close: async () => {
      try {
        await fixture.writer.close();
      } finally {
        await worker.close();
      }
    },
  };
  return fixture;
}
