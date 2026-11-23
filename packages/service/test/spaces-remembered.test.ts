// What a person last did to a space holds after a restart (A2 3.1, 3.2.4, 3.10.1): the space verbs
// record it in machine.toml's [[spaces]], keeping the person's own text, and a verb whose record
// cannot be written is done for this run and says so. Which copy of a space an ID or a name means
// when copies are served side by side (A2 3.10.5), over the socket and on the page's feed. Services
// run in this process on temporary homes; fixture data only.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "@ttasks/bridge/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { parseMachineConfig } from "../src/config/machine-toml.ts";
import { CLAIM_WARNING } from "../src/hub/space-verbs.ts";
import { configOf, stateOf } from "./harness.ts";
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
  message?: string;
  restored?: { at: string; backup?: string };
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
    "a create where a space is: the answer names ttasks space open <folder>, and a space created in a gone space's folder re-points its entry",
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

describe("[A2.3.1.hub.space-forget] a closed space is forgotten, and keeps its name until then", () => {
  test(
    "the name after a restart; forget refuses an open space, takes a closed one off the list and machine.toml, keeps its folder and clears the default",
    SLOW,
    async () => {
      const w = await world("forget");
      const user = await w.user();
      const lifeFolder = join(w.root, "s", "life");
      const life = (await user.call("space/create", { name: "Life", path: lifeFolder }, CALL)) as {
        space: Row;
      };
      await user.call("space/use", { space: life.space.id }, CALL);
      await user.call("space/close", { space: lifeFolder }, CALL);

      // After a restart, the closed space is listed with its name, read from its own folder.
      let again = await restart(w);
      expect((await list(again)).find((r) => r.folder === lifeFolder)).toMatchObject({
        name: "Life",
        state: "closed",
      });

      // An open space is not forgotten: the answer says to close it first, by its folder.
      const [mira] = await list(again);
      const open = errorOf(
        await again.call("space/forget", { space: "Mira" }, CALL).catch((e: unknown) => e),
      );
      expect(open.code).toBe("invalid_input");
      expect(open.hint).toContain("space close");
      expect(open.hint).toContain(mira?.folder ?? "?");

      // By its name: the closed one, also when its name were shared with an open copy.
      const forgotten = await again.call("space/forget", { space: "Life" }, CALL);
      expect(forgotten).toMatchObject({ forgotten: true, space: { folder: lifeFolder } });
      expect((await list(again)).map((r) => r.folder)).toEqual([mira?.folder]);
      expect(recorded(w).map((s) => s.path)).toEqual([mira?.folder]);
      expect(tomlOf(w)).not.toContain("default_space");
      expect(existsSync(join(lifeFolder, "space.db"))).toBe(true);
      // Forgotten is gone for good: not named, not back after a restart.
      const named = errorOf(
        await again.call("space/forget", { space: "Life" }, CALL).catch((e: unknown) => e),
      );
      expect(named.code).toBe("not_found");
      again = await restart(w);
      expect((await list(again)).map((r) => r.folder)).toEqual([mira?.folder]);

      // Its folder opened again lists it again, and records it.
      const back = await again.call("space/open", { path: lifeFolder }, CALL);
      expect(back).toMatchObject({ space: { name: "Life", state: "open" }, remembered: true });
      expect(recorded(w).map((s) => s.path)).toEqual([mira?.folder, lifeFolder]);
    },
  );

  test(
    "a forgotten space in this run, and one opened again in this run, as the list and the requests see them",
    SLOW,
    async () => {
      const w = await world("forget-run");
      const user = await w.user();
      const lifeFolder = join(w.root, "s", "life");
      await user.call("space/create", { name: "Life", path: lifeFolder }, CALL);
      await user.call("space/close", { space: "Life" }, CALL);
      await user.call("space/forget", { space: lifeFolder }, CALL);
      expect((await list(user)).map((r) => r.name)).toEqual(["Mira"]);
      // A request that names it finds no such space.
      const refused = errorOf(await get(user, "L-1", "Life").catch((e: unknown) => e));
      expect(refused.code).toBe("space_unavailable");
      await user.call("space/open", { path: lifeFolder }, CALL);
      expect((await list(user)).map((r) => [r.name, r.state])).toEqual([
        ["Mira", "open"],
        ["Life", "open"],
      ]);

      // A claimed copy beside its closed original: the name forgets the original, never the copy.
      const backup = (await user.call("space/backup", { space: lifeFolder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "life-copy");
      await user.call("space/close", { space: lifeFolder }, CALL);
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: lifeFolder },
        CALL,
      );
      await user.call("space/claim", { space: copyFolder }, CALL);
      const forgot = await user.call("space/forget", { space: "Life" }, CALL);
      expect(forgot).toMatchObject({ space: { folder: lifeFolder } });
      expect((await list(user)).map((r) => [r.name, r.state, r.folder === copyFolder])).toEqual([
        ["Mira", "open", false],
        ["Life", "open", true],
      ]);
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
      // The way to record it names `space open` of the folder, never the create again, which
      // would find a space in that folder.
      expect(made.not_remembered).toMatch(
        /^The space is open for now, but will not reopen after a restart: machine\.toml cannot be read as it is\. Run ttasks doctor: it names the problem\. Then run: ttasks space open /,
      );
      expect(made.not_remembered).toContain(studioFolder);
      const closed = (await user.call("space/close", { space: studioFolder }, CALL)) as {
        remembered: boolean;
        not_remembered: string;
      };
      expect(closed.remembered).toBe(false);
      expect(closed.not_remembered).toMatch(
        /^The space is closed for now, but a restart may open it again: machine\.toml cannot be read as it is\..* Then run: ttasks space close /,
      );
      // Nothing was written into the person's file.
      expect(tomlOf(w)).toBe(`${good}\n[log\n`);

      // Fixed, the command the line names records it.
      writeFileSync(fileOf(w), good);
      const opened = (await user.call("space/open", { path: studioFolder }, CALL)) as {
        space: Row;
      };
      expect(opened).toMatchObject({ space: { state: "open" }, remembered: true });
      expect(recorded(w).map((s) => s.path)).toEqual([expect.any(String), studioFolder]);

      // The person changes the folder's entry to name another space while the service runs: the
      // hand edit stays, and serving the space there is not pretended to be remembered.
      const studioId = opened.space.id;
      if (studioId === undefined) throw new Error("no Studio ID");
      const otherId = "sp_3z8sm956jp8dajmtsar5kx026c";
      const edited = tomlOf(w).replace(`id = "${studioId}"`, `id = "${otherId}"`);
      writeFileSync(fileOf(w), edited);
      const mismatch = (await user.call("space/open", { path: studioFolder }, CALL)) as {
        remembered: boolean;
        not_remembered: string;
      };
      expect(mismatch.remembered).toBe(false);
      expect(mismatch.not_remembered).toContain(
        "machine.toml's entry for this folder names another space.",
      );
      expect(mismatch.not_remembered).toContain(`Change that entry's id to ${studioId} by hand`);
      expect(tomlOf(w)).toBe(edited);
      writeFileSync(fileOf(w), tomlOf(w).replace(`id = "${otherId}"`, `id = "${studioId}"`));

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

describe("[A2.3.10.5.copies.service] one copy of a space is served at a time", () => {
  test(
    "a backup restored while its original is open is made but not opened; opening its folder is refused with what is open and what it is; once the original is closed the copy opens read-only as a restored copy, and its ID, its name, the default and the one space mean it; a restart opens only the copy",
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

      // By the backup's name, as `space backups` prints it, with the space it is of: the copy is
      // made, not opened, and the answer says how to look inside it.
      const copyFolder = join(w.root, "s", "mira-copy");
      const restored = (await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      )) as { folder: string; not_opened: string; space?: unknown };
      expect(restored).toMatchObject({ read_only_copy: true, folder: copyFolder });
      expect(restored.space).toBeUndefined();
      expect(restored.not_opened).toContain(`Mira is open from ${mira.folder}`);
      expect(restored.not_opened).toContain("space close");
      expect(restored.not_opened).toContain(copyFolder);
      expect((await list(user)).map((r) => r.folder)).toEqual([mira.folder]);
      expect(recorded(w).map((s) => s.path)).toEqual([mira.folder]);

      // Opening the copy's folder is refused while the original is open: what is open, what this
      // folder is, and the way to look inside it. Nothing is registered.
      const refused = errorOf(
        await user.call("space/open", { path: copyFolder }, CALL).catch((e: unknown) => e),
      );
      expect(refused).toMatchObject({
        code: "invalid_input",
        data: { reason: "other_copy_open" },
      });
      expect(refused.message).toContain(`Mira is open from ${mira.folder}.`);
      expect(refused.message).toContain("restored on");
      expect(refused.message).toContain(`from the backup ${backup.backup.name}.db.gz`);
      expect(refused.hint).toContain("close Mira first");
      expect((await list(user)).map((r) => r.folder)).toEqual([mira.folder]);
      // Everything still means the original.
      for (const space of [undefined, "Mira", mira.id, mira.folder]) {
        expect(await get(user, "M-2", space)).toMatchObject({ task: { ref: "M-2" } });
      }

      // The original closed, the copy opens: read-only, a restored copy by its own record, with
      // the way out. Its ID, its name, the default and the one space mean it now.
      await user.call("space/close", { space: mira.folder }, CALL);
      const opened = (await user.call("space/open", { path: copyFolder }, CALL)) as { space: Row };
      expect(opened.space).toMatchObject({
        state: "read_only",
        reason: "read_only_copy",
        restored: { backup: `${backup.backup.name}.db.gz` },
      });
      expect(opened.space.message).toContain("space claim <folder>");
      await user.call("space/use", { space: mira.id }, CALL);
      for (const space of [undefined, "Mira", mira.id, copyFolder]) {
        expect(await get(user, "M-1", space)).toMatchObject({ task: { ref: "M-1" } });
        expect(errorOf(await get(user, "M-2", space).catch((e: unknown) => e)).code).toBe(
          "not_found",
        );
      }
      const write = await add(user, "Into the copy", "copies-task-0004").catch((e: unknown) => e);
      expect(errorOf(write)).toMatchObject({
        code: "read_only",
        data: { reason: "read_only_copy" },
      });
      // Opening the original now is refused the same way, naming the copy that is open.
      const back = errorOf(
        await user.call("space/open", { path: mira.folder }, CALL).catch((e: unknown) => e),
      );
      expect(back.message).toContain(`Mira is open from ${copyFolder}.`);
      expect(back.message).toContain("This folder holds another copy of it.");

      // After a restart only the copy opens: the original was closed by the person.
      const again = await restart(w);
      expect((await list(again)).map((r) => [r.folder, r.state, r.reason])).toEqual([
        [mira.folder, "closed", undefined],
        [copyFolder, "read_only", "read_only_copy"],
      ]);
      expect(await get(again, "M-1")).toMatchObject({ task: { ref: "M-1" } });
    },
  );

  test(
    "at a start, two enabled folders of one space: the one that last wrote is served, the other stays closed and says why",
    SLOW,
    async () => {
      const w = await world("both-enabled");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      // An older build, or a hand edit, left both folders enabled, the copy listed first.
      await w.stop();
      writeFileSync(
        fileOf(w),
        `[[spaces]]\nid = "${mira.id}"\npath = ${JSON.stringify(copyFolder)}\n\n` +
          `[[spaces]]\nid = "${mira.id}"\npath = ${JSON.stringify(mira.folder)}\n`,
      );
      const again = await restart(w);
      const rows = await list(again);
      expect(rows.map((r) => [r.folder, r.state, r.reason])).toEqual([
        [copyFolder, "closed", "other_copy_open"],
        [mira.folder, "open", undefined],
      ]);
      expect(rows[0]?.message).toContain("Another copy of this space is open on this machine");
      expect((await add(again, "Into the space", "both-enabled-add-0001")).tasks[0]?.ref).toBe(
        "M-1",
      );
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
        "If another machine still has this space, its later changes will not appear here.",
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

  test(
    "the copy that last wrote keeps the writer at a start, also when an original listed before it is enabled again",
    SLOW,
    async () => {
      const w = await world("writer-first");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      await add(user, "Exported task", "writer-first-add-0001");
      const exported = (await user.call("space/export", { space: mira.folder }, CALL)) as {
        export: { file: string };
      };
      await user.call("space/close", { space: mira.folder }, CALL);
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call("space/restore", { backup: exported.export.file, to: copyFolder }, CALL);
      await user.call("space/claim", { space: copyFolder }, CALL);
      const written = (await add(user, "Only in the copy", "writer-first-add-0002")).tasks[0]?.ref;
      if (written === undefined) throw new Error("not written");

      // The person opens the original again while the copy writes: refused, and its entry stays
      // closed. A hand edit enables it, listed before the copy's.
      const opened = errorOf(
        await user.call("space/open", { path: mira.folder }, CALL).catch((e: unknown) => e),
      );
      expect(opened.data?.["reason"]).toBe("other_copy_open");
      expect(recorded(w).map((s) => [s.path, s.enabled])).toEqual([
        [mira.folder, false],
        [copyFolder, true],
      ]);
      await w.stop();
      writeFileSync(fileOf(w), tomlOf(w).replace("enabled = false\n", ""));
      expect(recorded(w).map((s) => [s.path, s.enabled])).toEqual([
        [mira.folder, true],
        [copyFolder, true],
      ]);

      // After a restart the copy the person wrote to still writes, and the task is there by the
      // space's ID and without one.
      const again = await restart(w);
      const rows = await list(again);
      expect(rows.find((r) => r.folder === copyFolder)?.state).toBe("open");
      expect(rows.find((r) => r.folder === mira.folder)).toMatchObject({
        state: "closed",
        reason: "other_copy_open",
      });
      expect(await get(again, written, mira.id)).toMatchObject({ task: { ref: written } });
      expect(await get(again, written)).toMatchObject({ task: { ref: written } });
    },
  );

  test(
    "a claimed copy moved by hand, its entry's path changed, still writes at a start; and space open of the copy that writes records it again when its settings could not be written",
    SLOW,
    async () => {
      const w = await world("writer-moved");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      const exported = (await user.call("space/export", { space: mira.folder }, CALL)) as {
        export: { file: string };
      };
      await user.call("space/close", { space: mira.folder }, CALL);
      const copyFolder = join(w.root, "s", "mira-copy");
      await user.call("space/restore", { backup: exported.export.file, to: copyFolder }, CALL);
      await user.call("space/claim", { space: copyFolder }, CALL);
      const written = (await add(user, "Only in the copy", "writer-moved-add-0001")).tasks[0]?.ref;
      if (written === undefined) throw new Error("not written");

      // Moved by hand while the service is stopped, machine.toml changed to the new folder, and
      // the original enabled again by hand.
      await w.stop();
      const movedFolder = join(w.root, "s", "mira-moved");
      renameSync(copyFolder, movedFolder);
      writeFileSync(
        fileOf(w),
        tomlOf(w).replace(copyFolder, movedFolder).replace("enabled = false\n", ""),
      );
      expect(recorded(w).map((s) => s.path)).toEqual([mira.folder, movedFolder]);
      let again = await restart(w);
      expect((await list(again)).find((r) => r.folder === movedFolder)?.state).toBe("open");
      expect(await get(again, written, mira.id)).toMatchObject({ task: { ref: written } });

      // The space's settings cannot be written while the original takes the writer back by hand:
      // the next start may follow the older record, until space open of the copy that writes.
      const settings = join(stateOf(w.home), "spaces", `${mira.id}.json`);
      await again.call("space/close", { space: movedFolder }, CALL);
      await again.call("space/open", { path: mira.folder }, CALL);
      await again.call("space/close", { space: mira.folder }, CALL);
      const kept = readFileSync(settings, "utf8");
      rmSync(settings);
      mkdirSync(settings);
      await again.call("space/open", { path: movedFolder }, CALL);
      rmSync(settings, { recursive: true });
      writeFileSync(settings, kept);
      const recordedAgain = (await again.call("space/open", { path: movedFolder }, CALL)) as {
        space: Row;
      };
      expect(recordedAgain.space.state).toBe("open");
      await w.stop();
      writeFileSync(fileOf(w), tomlOf(w).replace("enabled = false\n", ""));
      again = await restart(w);
      expect((await list(again)).find((r) => r.folder === movedFolder)?.state).toBe("open");
      expect(await get(again, written, mira.id)).toMatchObject({ task: { ref: written } });
    },
  );

  test(
    "a restored copy whose folder the person deleted stays listed, and never makes a call without a space ask for one",
    SLOW,
    async () => {
      const w = await world("gone-copy");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      const backup = (await user.call("space/backup", { space: mira.folder }, CALL)) as {
        backup: { name: string };
      };
      const copyFolder = join(w.root, "s", "look");
      await user.call("space/close", { space: mira.folder }, CALL);
      await user.call(
        "space/restore",
        { backup: backup.backup.name, to: copyFolder, of: mira.folder },
        CALL,
      );
      await user.call("space/close", { space: copyFolder }, CALL);
      await user.call("space/open", { path: mira.folder }, CALL);
      // A hand edit enables the copy again, whose folder the person then deleted.
      await w.stop();
      writeFileSync(fileOf(w), tomlOf(w).replace("enabled = false\n", ""));
      rmSync(copyFolder, { recursive: true, force: true });
      const again = await restart(w);
      expect((await list(again)).map((r) => [r.folder, r.state])).toEqual([
        [mira.folder, "open"],
        [copyFolder, "closed"],
      ]);
      expect((await add(again, "Without a space", "gone-copy-add-0001")).tasks[0]?.ref).toMatch(
        /^M-\d+$/,
      );
    },
  );
});

describe("[A2.3.10.1.recover.id-check] recover checks the space before it plays a journal back", () => {
  test(
    "a folder whose space.json names another space is refused with nothing changed; the entry's own space is recovered and recorded open",
    SLOW,
    async () => {
      const w = await world("recover");
      const user = await w.user();
      const [mira] = await list(user);
      if (mira?.id === undefined) throw new Error("no Mira");
      const otherFolder = join(w.root, "s", "other");
      await user.call("space/create", { name: "Other", path: otherFolder }, CALL);
      await user.call("space/close", { space: otherFolder }, CALL);
      await user.call("space/close", { space: mira.folder }, CALL);

      // A stray rollback journal beside the database: the space is refused until it is recovered.
      writeFileSync(join(mira.folder, "space.db-journal"), "");
      const refused = await user.call("space/open", { path: mira.folder }, CALL);
      expect(refused).toMatchObject({
        space: { state: "unavailable", reason: "needs_recovery" },
        remembered: true,
      });

      // Another space with a journal of its own is put in the folder since: not this entry's to
      // recover, and nothing of it is played back or moved.
      const aside = `${mira.folder}-aside`;
      renameSync(mira.folder, aside);
      renameSync(otherFolder, mira.folder);
      writeFileSync(join(mira.folder, "space.db-journal"), "");
      const before = readdirSync(join(w.root, "s")).sort();
      const mismatch = await user
        .call("space/recover", { space: mira.folder }, CALL)
        .catch((e: unknown) => e);
      expect(errorOf(mismatch)).toMatchObject({ data: { cause: "SPACE_ID_MISMATCH" } });
      expect(readdirSync(join(w.root, "s")).sort()).toEqual(before);
      expect(existsSync(join(mira.folder, "space.db-journal"))).toBe(true);

      // The entry's own space back: recovered, the old folder kept beside it, open and recorded.
      renameSync(mira.folder, otherFolder);
      renameSync(aside, mira.folder);
      const recovered = await user.call("space/recover", { space: mira.folder }, CALL);
      expect(recovered).toMatchObject({
        recovered: true,
        space: { state: "open" },
        remembered: true,
      });
      expect(readdirSync(join(w.root, "s")).some((name) => name.startsWith("mira.replaced-"))).toBe(
        true,
      );
      expect(recorded(w).find((s) => s.path === mira.folder)?.enabled).toBe(true);
    },
  );
});
