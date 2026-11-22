// The machine's default space (A2 3.1, 3.2.4, 3.10.5; A5 3.3; A7 M5.01): Make default over the
// UI's HTTP route and `space/use` over the socket write `[service] default_space` to machine.toml,
// and the default decides only what a new tab (a feed subscription that names no space) and an
// unbound call of the person use. A tab that names its space, and an agent's CLI, never get it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";
import { configOf } from "./harness.ts";
import { classSession, errorOf } from "./ops-helpers.ts";

const SLOW = { timeout: 240_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

/** machine.toml's text, or "" while the file does not exist. */
function machineToml(world: HttpWorld): string {
  const file = join(configOf(world.home), "machine.toml");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

interface Listed {
  readonly spaces: { id: string; name: string; state: string }[];
  readonly default: string | null;
}

describe("[A2.3.1.default-space] Make default and the machine's default space", () => {
  test(
    "Make default writes machine.toml; a new tab and an unbound call of the person use it, nothing else does",
    SLOW,
    async () => {
      const world = await httpWorld("default-space");
      worlds.push(world);
      const user = await world.user();
      const created = (await user.call(
        "space/create",
        { name: "Studio", path: join(world.root, "s", "studio"), ref_prefix: "S" },
        { timeoutMs: 120_000 },
      )) as { space: { id: string } };
      const studio = created.space.id;
      const { token } = await signIn(world);
      const port = world.port();
      const list = async (): Promise<Listed> => {
        const reply = await post(port, "/api/v1/space/list", {}, { token });
        expect(reply.status).toBe(200);
        return (JSON.parse(reply.body) as { result: Listed }).result;
      };

      const before = await list();
      expect(before.default).toBeNull();
      expect(before.spaces.map((s) => s.name).sort()).toEqual(["Mira", "Studio"]);
      const mira = before.spaces.find((s) => s.name === "Mira")?.id ?? "";
      // Two spaces and no default: an unbound call of the person must name one.
      const addUnbound = (session: typeof user, n: number) =>
        session.call(
          "op/call",
          {
            op: "task.add",
            input: {
              tasks: [{ title: `Unbound ${String(n)}` }],
              request_id: `default-space-unbound-${String(n).padStart(2, "0")}`,
            },
          },
          { timeoutMs: 60_000 },
        );
      expect(errorOf(await addUnbound(user, 1).catch((e: unknown) => e)).code).toBe(
        "invalid_input",
      );

      // A page without a token, a body that is not a space ID, a space this machine lacks.
      expect((await post(port, "/api/v1/space/default", { space: studio })).status).toBe(401);
      const bad = await post(port, "/api/v1/space/default", { space: "Studio" }, { token });
      expect(bad.status).toBe(400);
      const unknown = await post(
        port,
        "/api/v1/space/default",
        { space: "sp_0123456789abcdefghjkmnpqrs" },
        { token },
      );
      expect(unknown.status).toBe(404);
      expect(machineToml(world)).not.toContain("default_space");

      // Make default: written to machine.toml, named by the list.
      const made = await post(port, "/api/v1/space/default", { space: studio }, { token });
      expect(made.status).toBe(200);
      expect(JSON.parse(made.body)).toEqual({ result: { default: studio } });
      expect(machineToml(world)).toMatch(
        new RegExp(`\\[service\\]\\s*\\ndefault_space = "${studio}"`),
      );
      expect((await list()).default).toBe(studio);
      const listed = (await user.call("space/list", {}, { timeoutMs: 60_000 })) as {
        default: string;
      };
      expect(listed.default).toBe(studio);

      // An unbound call of the person now lands in the default space; an agent's never does.
      const added = (await addUnbound(user, 2)) as { tasks: { ref: string }[] };
      expect(added.tasks[0]?.ref).toMatch(/^S-\d+$/);
      const agent = await classSession(world.home, world.service.endpoint.path, "cli-agent", {
        CLAUDECODE: "1",
      });
      try {
        expect(errorOf(await addUnbound(agent, 3).catch((e: unknown) => e)).code).toBe(
          "invalid_input",
        );
        // Only the user changes the default.
        const refused = await agent.call("space/use", { space: mira }).catch((e: unknown) => e);
        expect(errorOf(refused).code).toBe("forbidden");
      } finally {
        agent.close();
      }

      // A new tab (no space named) gets the default; a tab that names its space keeps it.
      const fresh = await openFeed(port, token);
      fresh.send({ type: "subscribe" });
      const opened = await fresh.next((m) => m["type"] === "snapshot");
      expect((opened["space"] as { id: string }).id).toBe(studio);
      const named = await openFeed(port, token);
      named.send({ type: "subscribe", space: mira });
      const kept = await named.next((m) => m["type"] === "snapshot");
      expect((kept["space"] as { id: string }).id).toBe(mira);
      fresh.ws.close();
      named.ws.close();

      // `ttasks space use` sets it back, the same way.
      expect(await user.call("space/use", { space: mira }, { timeoutMs: 60_000 })).toEqual({
        default: mira,
      });
      expect((await list()).default).toBe(mira);

      // After a restart the default is read from machine.toml, and both spaces, which
      // `space/create` recorded in [[spaces]], open again: an unbound call lands in the default.
      expect(await user.call("space/use", { space: studio }, { timeoutMs: 60_000 })).toEqual({
        default: studio,
      });
      await world.restart();
      await world.service.spacesSettled;
      const again = await world.user();
      const { token: token2 } = await signIn(world);
      const relisted = (
        JSON.parse(
          (await post(world.port(), "/api/v1/space/list", {}, { token: token2 })).body,
        ) as {
          result: Listed;
        }
      ).result;
      expect(relisted.default).toBe(studio);
      expect(relisted.spaces.map((s) => s.name).sort()).toEqual(["Mira", "Studio"]);
      const landed = (await addUnbound(again, 4)) as { tasks: { ref: string }[] };
      expect(landed.tasks[0]?.ref).toMatch(/^S-\d+$/);

      // A default that is set but not served (closed now) is space_unavailable for an unbound
      // call and a new tab, never another space.
      await again.call(
        "space/close",
        { space: join(world.root, "s", "studio") },
        { timeoutMs: 60_000 },
      );
      expect(errorOf(await addUnbound(again, 5).catch((e: unknown) => e)).code).toBe(
        "space_unavailable",
      );
      const orphan = await openFeed(world.port(), token2);
      orphan.send({ type: "subscribe" });
      expect(await orphan.next((m) => m["type"] === "error")).toEqual({
        type: "error",
        code: "space_unavailable",
      });
      orphan.ws.close();
    },
  );
});
