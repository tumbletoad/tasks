// Settings for this computer over the page's routes (A7 M5.11): the theme and the single-letter
// keys are machine preferences in machine.toml, the person's own lines and comments kept; every
// open tab's feed follows a change, a new tab gets them after `hello`, and the shell paints the
// theme from the first byte. Open's terminal: which one and why, the ones found here, a choice
// and the way back to the operating system's default.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { send, post } from "./http-client.ts";
import { httpWorld, openFeed, signIn, type HttpWorld } from "./http-world.ts";
import { configOf, twoTerminalsHost } from "./harness.ts";

const SLOW = { timeout: 240_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

const machineToml = (world: HttpWorld): string => {
  const file = join(configOf(world.home), "machine.toml");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

/** The person's own `[terminal]`: kitty, at a path of its own, with comments. */
const KITTY = process.platform === "win32" ? "C:\\kitty\\kitty.exe" : "/opt/kitty/bin/kitty";
const MINE = `# my terminal\n[terminal]\napp = "kitty" # the fast one\npath = '${KITTY}'\n`;

/** machine.toml's text up to the spaces the world's start records after the person's lines. */
const own = (text: string): string => text.split("\n[[spaces]]")[0] ?? "";

/** A shell with the placeholders a built page carries. */
const UI = {
  index:
    '<!doctype html><html lang="en" data-theme="__TASKS_THEME__"><head>' +
    '<meta name="csp-nonce" content="__TASKS_NONCE__"></head><body></body></html>',
  files: new Map(),
};

const isMachine = (m: Record<string, unknown>) => m["type"] === "machine";
const themeOf = (m: Record<string, unknown>) =>
  (m["preferences"] as { key: string; value: unknown }[]).find((p) => p.key === "ui.theme")?.value;

describe("[A7.3.12.m5-11.machine-settings] this computer's settings, kept in machine.toml", () => {
  test(
    "the theme and the keys are set and reset in machine.toml, and every tab and the shell follow at once",
    SLOW,
    async () => {
      const world = await httpWorld(
        "machine-settings",
        { ui: UI },
        { toml: MINE, launch: { terminals: { host: twoTerminalsHost } } },
      );
      worlds.push(world);
      const { token } = await signIn(world);
      const port = world.port();
      const shell = async () =>
        (await send(port, { path: "/", headers: { "sec-fetch-site": "none" } })).body;
      expect(await shell()).toContain('data-theme="sumi"');

      // An open tab gets this computer's settings right after hello.
      const tab = await openFeed(port, token);
      const first = await tab.next(isMachine);
      expect(first["preferences"]).toEqual([
        { key: "ui.theme", value: "sumi", state: "default" },
        { key: "ui.single_keys", value: true, state: "default" },
      ]);

      // Only a signed-in page, a key of the page's and a value of its shape.
      const set = (body: unknown, auth = true) =>
        post(port, "/api/v1/machine/pref", body, auth ? { token } : {});
      expect((await set({ key: "ui.theme", value: "washi" }, false)).status).toBe(401);
      for (const body of [
        { key: "ui.theme", value: "purple" },
        { key: "ui.theme" },
        { key: "projection.dir", value: "/srv/view" },
        { key: "autonomy.level", value: "full" },
      ]) {
        expect((await set(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(own(machineToml(world))).toBe(MINE);

      const washi = await set({ key: "ui.theme", value: "washi" });
      expect(washi.status).toBe(200);
      expect(JSON.parse(washi.body)).toEqual({
        result: { key: "ui.theme", value: "washi", state: "set" },
      });
      expect(themeOf(await tab.next(isMachine))).toBe("washi");
      expect(await shell()).toContain('data-theme="washi"');
      expect((await set({ key: "ui.single_keys", value: false })).status).toBe(200);
      const keys = await tab.next(isMachine);
      expect(keys["preferences"]).toContainEqual({
        key: "ui.single_keys",
        value: false,
        state: "set",
      });
      // The person's own lines stay, byte for byte.
      const written = machineToml(world);
      expect(written.startsWith(MINE)).toBe(true);
      expect(written).toContain('"ui.theme" = "washi"');
      expect(written).toContain('"ui.single_keys" = false');

      // A new tab, as a fresh browser would open it, gets the same.
      const fresh = await openFeed(port, token);
      expect(themeOf(await fresh.next(isMachine))).toBe("washi");

      // Back to the default: the line goes, everything else stays.
      expect((await set({ key: "ui.theme", value: null })).status).toBe(200);
      expect(themeOf(await tab.next(isMachine))).toBe("sumi");
      expect(themeOf(await fresh.next(isMachine))).toBe("sumi");
      expect(machineToml(world)).not.toContain("ui.theme");
      expect(machineToml(world).startsWith(MINE)).toBe(true);

      // A restart reads what was written.
      await world.restart({ ui: UI });
      const again = await signIn(world);
      const after = await openFeed(world.port(), again.token);
      expect((await after.next(isMachine))["preferences"]).toContainEqual({
        key: "ui.single_keys",
        value: false,
        state: "set",
      });
      for (const feed of [tab, fresh, after]) feed.ws.close();
    },
  );

  test(
    "Open's terminal: which one and why, a choice among those found, and back to the default",
    SLOW,
    async () => {
      const world = await httpWorld(
        "machine-terminal",
        {},
        { toml: MINE, launch: { terminals: { host: twoTerminalsHost }, shimCommand: ["/t"] } },
      );
      worlds.push(world);
      const { token } = await signIn(world);
      const port = world.port();
      const terminal = async (body: unknown) => {
        const reply = await post(port, "/api/v1/machine/terminal", body, { token });
        return { status: reply.status, body: JSON.parse(reply.body) as Record<string, unknown> };
      };

      // machine.toml chooses kitty, with a path of its own.
      expect((await terminal({})).body).toEqual({
        result: {
          terminal: {
            chosen: "kitty",
            used: { app: "kitty", source: "configured", found: true },
            unsupported: null,
            unread: null,
            installed: ["ghostty", "kitty"],
          },
        },
      });

      // A terminal that is not here is refused, and nothing is written.
      expect((await terminal({ app: "konsole" })).status).toBe(404);
      expect((await terminal({ app: "nonsense" })).status).toBe(400);
      expect(own(machineToml(world))).toBe(MINE);

      // Ghostty: the app is replaced in place, and kitty's path goes with kitty.
      const ghostty = await terminal({ app: "ghostty" });
      expect(ghostty.status).toBe(200);
      expect(ghostty.body["result"]).toMatchObject({
        terminal: { chosen: "ghostty", used: { app: "ghostty", source: "configured" } },
      });
      expect(own(machineToml(world))).toBe(
        '# my terminal\n[terminal]\napp = "ghostty" # the fast one\n',
      );

      // Back to the default: the line goes, the table and the comment stay.
      const auto = await terminal({ app: "auto" });
      expect(auto.body["result"]).toMatchObject({
        terminal: { chosen: "auto", used: { app: "ghostty", source: "installed", found: true } },
      });
      const back = machineToml(world);
      expect(own(back)).toBe("# my terminal\n[terminal]\n");
      // Again: nothing to change, nothing written.
      expect((await terminal({ app: "auto" })).status).toBe(200);
      expect(machineToml(world)).toBe(back);

      // An editor puts kitty and its path back while the service runs; Ghostty chosen then takes
      // that path out too, so it is never started as kitty's program.
      const file = join(configOf(world.home), "machine.toml");
      writeFileSync(
        file,
        back.replace("[terminal]\n", `[terminal]\napp = "kitty"\npath = '${KITTY}'\n`),
      );
      expect((await terminal({ app: "ghostty" })).status).toBe(200);
      expect(own(machineToml(world))).toBe('# my terminal\n[terminal]\napp = "ghostty"\n');
    },
  );
});
