// What a person last did to a space holds after a restart (A2 3.1, 3.2.4, 3.10.1): the space verbs
// record it in machine.toml's [[spaces]], keeping the person's own text, and a verb whose record
// cannot be written is done for this run and says so. Which copy of a space an ID or a name means
// when copies are served side by side (A2 3.10.5), over the socket and on the page's feed. Services
// run in this process on temporary homes; fixture data only.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@tasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { parseMachineConfig } from "../src/config/machine-toml.ts";
import { CLAIM_WARNING } from "../src/hub/space-verbs.ts";
import { configOf } from "./harness.ts";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";
import { errorOf } from "./ops-helpers.ts";

const SLOW = { timeout: 300_000 };
const CALL = { timeoutMs: 120_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function world(label: string): Promise<HttpWorld> {
  const made = await httpWorld(label);
  worlds.push(made);
  return made;
}

const fileOf = (w: HttpWorld) => join(configOf(w.home), "machine.toml");
const tomlOf = (w: HttpWorld) => (existsSync(fileOf(w)) ? readFileSync(fileOf(w), "utf8") : "");
const recorded = (w: HttpWorld) =>
  parseMachineConfig(tomlOf(w), process.platform).config.spaces.map((s) => ({ ...s }));

interface Row {
  entry: number;
  id?: string;
  registered?: string;
  name?: string;
  state: string;
  reason?: string;
  folder: string;
}

async function list(user: RpcSession): Promise<Row[]> {
  return ((await user.call("space/list", {}, CALL)) as { spaces: Row[] }).spaces;
}

/** The service again on the same home, with its spaces settled. */
async function restart(w: HttpWorld): Promise<RpcSession> {
  await w.restart();
  await w.service.spacesSettled;
  return w.user();
}

const add = (user: RpcSession, title: string, requestId: string, space?: string) =>
  user.call(
    "op/call",
    {
      op: "task.add",
      input: { tasks: [{ title }], request_id: requestId },
      ...(space === undefined ? {} : { space }),
    },
    CALL,
  ) as Promise<{ tasks: { ref: string }[] }>;

const get = (user: RpcSession, task: string, space?: string) =>
  user.call(
    "op/call",
    { op: "task.get", input: { task }, ...(space === undefined ? {} : { space }) },
    CALL,
  );

describe("[A2.3.1.hub.spaces-remembered] what a person last did to a space holds after a restart", () => {
  test(
    "create, open and close are recorded with the person's text and mode kept; a restart serves what they left; a missing folder is shown, never dropped",
    SLOW,
    async () => {
      const w = await world("remembered");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      expect(recorded(w)).toEqual([{ id: mira.id, path: mira.folder, enabled: true }]);

      // The person's own notes and a setting, written by hand while the service runs.
      const mine = '# My machine.\n[log]\nlevel = "info" # as it was\n\n';
      writeFileSync(fileOf(w), `${mine}${tomlOf(w)}`);
      if (process.platform !== "win32") chmodSync(fileOf(w), 0o640);

      const studioFolder = join(w.root, "s", "studio");
      const studio = (await user.call(
        "space/create",
        { name: "Studio", path: studioFolder, ref_prefix: "S" },
        CALL,
      )) as { space: Row; remembered: boolean };
      expect(studio).toMatchObject({ space: { state: "open" }, remembered: true });
      const lifeFolder = join(w.root, "s", "life");
      const life = (await user.call("space/create", { name: "Life", path: lifeFolder }, CALL)) as {
        space: Row;
      };
      const closed = await user.call("space/close", { space: lifeFolder }, CALL);
      expect(closed).toMatchObject({ space: { state: "closed" }, remembered: true });

      expect(tomlOf(w).startsWith(mine)).toBe(true);
      expect(recorded(w)).toEqual([
        { id: mira.id, path: mira.folder, enabled: true },
        { id: studio.space.id, path: studioFolder, enabled: true },
        { id: life.space.id, path: lifeFolder, enabled: false },
      ]);
      if (process.platform !== "win32") expect(statSync(fileOf(w)).mode & 0o777).toBe(0o640);

      // After a restart: the open spaces are open, the closed one is listed closed with its ID.
      let again = await restart(w);
      const rows = await list(again);
      expect(rows.map((r) => [r.folder, r.state, r.id ?? r.registered])).toEqual([
        [mira.folder, "open", mira.id],
        [studioFolder, "open", studio.space.id],
        [lifeFolder, "closed", life.space.id],
      ]);
      // A call that names a space by its name reaches it, as before the restart.
      const added = await add(again, "After the restart", "remembered-add-0001", "Studio");
      expect(added.tasks[0]?.ref).toMatch(/^S-\d+$/);
      // Opened again, and recorded so.
      const reopened = await again.call("space/open", { path: lifeFolder }, CALL);
      expect(reopened).toMatchObject({ space: { name: "Life", state: "open" }, remembered: true });
      expect(recorded(w).map((s) => s.enabled)).toEqual([true, true, true]);

      // A hand edit made while the service runs is kept by the next record.
      writeFileSync(fileOf(w), `${tomlOf(w)}\n[ui]\nopen_mode = "app"\n`);
      await again.call("space/close", { space: studioFolder }, CALL);
      expect(tomlOf(w)).toContain('\n[ui]\nopen_mode = "app"\n');
      expect(tomlOf(w).startsWith(mine)).toBe(true);
      expect(recorded(w).map((s) => s.enabled)).toEqual([true, false, true]);

      // A folder gone at the start: the service starts, the other spaces open, the entry is shown
      // unavailable with its reason and stays in machine.toml.
      await again.call("space/open", { path: studioFolder }, CALL);
      await w.stop();
      renameSync(studioFolder, `${studioFolder}-aside`);
      again = await restart(w);
      const withGone = await list(again);
      expect(withGone.map((r) => [r.folder, r.state, r.reason])).toEqual([
        [mira.folder, "open", undefined],
        [studioFolder, "unavailable", "missing"],
        [lifeFolder, "open", undefined],
      ]);
      expect(withGone[1]?.registered).toBe(studio.space.id);
      expect(recorded(w)).toHaveLength(3);
      // Back in place, `space open` tries it again.
      renameSync(`${studioFolder}-aside`, studioFolder);
      const back = await again.call("space/open", { path: studioFolder }, CALL);
      expect(back).toMatchObject({ space: { name: "Studio", state: "open" }, remembered: true });
    },
  );

  test(
    "a create where a space is: the answer names tasks space open <folder>, and a space created in a gone space's folder re-points its entry",
    SLOW,
    async () => {
      const w = await world("exists");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      const there = await user
        .call("space/create", { name: "Mira", path: mira.folder }, CALL)
        .catch((e: unknown) => e);
      const body = errorOf(there);
      expect(body.code).toBe("invalid_input");
      expect(body.message).toBe("A space is already in that folder.");
      expect(body.hint).toContain("space open");
      expect(body.hint).toContain(mira.folder);

      // The folder goes while the service is stopped; a new space made there is the entry's now.
      await w.stop();
      renameSync(mira.folder, `${mira.folder}-old`);
      const again = await restart(w);
      const made = (await again.call(
        "space/create",
        { name: "Mira again", path: mira.folder },
        CALL,
      )) as { space: Row; remembered: boolean };
      expect(made).toMatchObject({ space: { state: "open" }, remembered: true });
      expect(made.space.id).not.toBe(mira.id);
      expect(recorded(w)).toEqual([{ id: made.space.id, path: mira.folder, enabled: true }]);
    },
  );
});

describe("[A2.3.1.hub.spaces-not-remembered] a record machine.toml cannot take is not pretended", () => {
  test(
    "the verb is done for this run, its answer says a restart will not keep it and why, and running it again once the file is fixed records it",
    SLOW,
    async () => {
      const w = await world("not-remembered");
      const user = await w.user();
      const good = tomlOf(w);
      // A hand edit left a syntax error.
      writeFileSync(fileOf(w), `${good}\n[log\n`);
      const studioFolder = join(w.root, "s", "studio");
      const made = (await user.call(
        "space/create",
        { name: "Studio", path: studioFolder },
        CALL,
      )) as {
        space: Row;
        remembered: boolean;
        not_remembered: string;
      };
      expect(made).toMatchObject({ space: { state: "open" }, remembered: false });
      expect(made.not_remembered).toBe(
        "The space is open for now, but will not reopen after a restart: machine.toml cannot be read as it is. Run tasks doctor: it names the problem. Then run this command again.",
      );
      const closed = (await user.call("space/close", { space: studioFolder }, CALL)) as {
        remembered: boolean;
        not_remembered: string;
      };
      expect(closed.remembered).toBe(false);
      expect(closed.not_remembered).toMatch(
        /^The space is closed for now, but a restart may open it again: machine\.toml cannot be read as it is\./,
      );
      // Nothing was written into the person's file.
      expect(tomlOf(w)).toBe(`${good}\n[log\n`);

      // Fixed, the same verb records it.
      writeFileSync(fileOf(w), good);
      const opened = await user.call("space/open", { path: studioFolder }, CALL);
      expect(opened).toMatchObject({ space: { state: "open" }, remembered: true });
      expect(recorded(w).map((s) => s.path)).toEqual([expect.any(String), studioFolder]);

      // A file another user could change is refused, on the systems that have modes.
      if (process.platform !== "win32") {
        chmodSync(fileOf(w), 0o666);
        const refused = (await user.call("space/close", { space: studioFolder }, CALL)) as {
          remembered: boolean;
          not_remembered: string;
        };
        expect(refused.remembered).toBe(false);
        expect(refused.not_remembered).toContain("fails the permission rule");
        chmodSync(fileOf(w), 0o600);
      }
    },
  );
});

describe("[A2.3.10.5.copies.service] copies of one space served side by side", () => {
  test(
    "a backup restored beside its open original: an ID, a name, the default and the one space mean the original; the folder reaches the copy; a restart keeps both",
    SLOW,
    async () => {
      const w = await world("copies");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      await add(user, "Before the backup", "copies-task-0001");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      // M-2 is only in the original: the backup came before it.
      expect((await add(user, "After the backup", "copies-task-0002")).tasks[0]?.ref).toBe("M-2");

      // By the backup's name, as `space backups` prints it, with the space it is of.
      const copyFolder = join(w.root, "s", "mira-copy");
      const restored = await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      expect(restored).toMatchObject({
        read_only_copy: true,
        space: { state: "read_only", reason: "read_only_copy" },
        remembered: true,
      });

      const original = async (space?: string) => {
        expect(await get(user, "M-2", space)).toMatchObject({ task: { ref: "M-2" } });
      };
      for (const space of [undefined, "Mira", "mira", mira.id, mira.folder]) await original(space);
      // A write without a space goes to the original too.
      expect((await add(user, "Beside the copy", "copies-task-0003")).tasks[0]?.ref).toBe("M-3");
      // The default names the space by its ID: the same copy.
      await user.call("space/use", { space: mira.id }, CALL);
      await original();
      // The copy by its folder: it answers reads, and refuses writes as a read-only copy.
      expect(await get(user, "M-1", copyFolder)).toMatchObject({ task: { ref: "M-1" } });
      expect(errorOf(await get(user, "M-2", copyFolder).catch((e: unknown) => e)).code).toBe(
        "not_found",
      );
      const write = await add(user, "Into the copy", "copies-task-0004", copyFolder).catch(
        (e: unknown) => e,
      );
      expect(errorOf(write)).toMatchObject({
        code: "read_only",
        data: { reason: "read_only_copy" },
      });

      // After a restart both are served again; the original, first in machine.toml, writes.
      const again = await restart(w);
      expect((await list(again)).map((r) => [r.folder, r.state, r.reason])).toEqual([
        [mira.folder, "open", undefined],
        [copyFolder, "read_only", "read_only_copy"],
      ]);
      expect(await get(again, "M-3")).toMatchObject({ task: { ref: "M-3" } });
      expect(await get(again, "M-1", copyFolder)).toMatchObject({ task: { ref: "M-1" } });
    },
  );

  test(
    "[A2.3.10.5.copies.feed] after export, close, restore of the bundle and claim, the page follows the claimed copy, and the claim holds over a restart",
    SLOW,
    async () => {
      const w = await world("claimed");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      await add(user, "Exported task", "claimed-add-0001");
      const exported = (await user.call("space/export", { space: mira.folder }, CALL)) as {
        export: { file: string };
      };
      await user.call("space/close", { space: mira.folder }, CALL);
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call("space/restore", { backup: exported.export.file, to: copyFolder }, CALL);
      const claimed = await user.call("space/claim", { space: copyFolder }, CALL);
      expect(claimed).toMatchObject({
        space: { state: "open" },
        warning: CLAIM_WARNING,
        remembered: true,
      });
      expect(CLAIM_WARNING).toBe(
        "If another computer still has this space, its later changes will not appear here.",
      );
      expect(recorded(w)).toEqual([
        { id: mira.id, path: mira.folder, enabled: false },
        { id: mira.id, path: copyFolder, enabled: true },
      ]);

      const follows = async (session: RpcSession, requestId: string) => {
        const { token } = await signIn(w);
        const feed = await openFeed(w.port(), token);
        try {
          feed.send({ type: "subscribe", space: mira.id });
          const first = await feed.next((m) => m["type"] === "snapshot" || m["type"] === "error");
          expect(first["type"]).toBe("snapshot");
          // A write to the space: the feed sends it, never "space_unavailable" for the closed
          // original listed first.
          const ref = (await add(session, "Written to the copy", requestId)).tasks[0]?.ref;
          expect(ref).toMatch(/^M-\d+$/);
          const next = await feed.next(
            (m) =>
              m["type"] === "error" ||
              (m["type"] === "batch" && (m["events"] as unknown[]).length > 0),
            60_000,
          );
          expect(next["type"]).toBe("batch");
        } finally {
          feed.ws.close();
        }
      };
      await follows(user, "claimed-add-0002");

      // After a restart only the claimed copy opens; the original is listed closed.
      const again = await restart(w);
      expect((await list(again)).map((r) => [r.folder, r.state])).toEqual([
        [mira.folder, "closed"],
        [copyFolder, "open"],
      ]);
      await follows(again, "claimed-add-0003");
    },
  );
});
