import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSpacePath, ID_ALPHABET } from "@ttasks/storage";
import { ID_ALPHABET as PATHS_ALPHABET } from "./paths.ts";
import { afterEach, describe, expect, test } from "vitest";
import {
  canonicalStatePath,
  installId,
  isInstallId,
  LayoutError,
  pipeName,
  resolveLayout,
  runtimeNames,
  type HostFacts,
} from "./paths.ts";

const facts = (
  platform: NodeJS.Platform,
  env: Record<string, string>,
  accountHome: string | undefined,
  uid?: number,
): HostFacts => ({ platform, env, accountHome, uid });

// Every XDG variable set to somewhere else: none may change a path (A2 3.2.2 rule 2).
const XDG = {
  XDG_CONFIG_HOME: "/elsewhere/config",
  XDG_STATE_HOME: "/elsewhere/state",
  XDG_CACHE_HOME: "/elsewhere/cache",
  XDG_RUNTIME_DIR: "/elsewhere/run",
};

describe("[A2.3.2.hub.paths] state folders per OS", () => {
  test("Linux: from the account's home, whatever HOME a snap sets and whatever XDG says", () => {
    const layout = resolveLayout(
      facts("linux", { HOME: "/home/mira/snap/firefox/7429", ...XDG }, "/home/mira", 1000),
    );
    expect(layout).toEqual({
      platform: "linux",
      root: "/home/mira/.local/share/ttasks",
      bin: "/home/mira/.local/bin",
      data: "/home/mira/.ttasks",
      config: "/home/mira/.ttasks/config",
      state: "/home/mira/.ttasks/state",
      cache: "/home/mira/.ttasks/cache",
      logs: "/home/mira/.ttasks/state/logs",
      crash: "/home/mira/.ttasks/state/crash",
      tmp: "/home/mira/.ttasks/state/tmp",
      workdirs: "/home/mira/.ttasks/state/workdirs",
      spaces: "/home/mira/.ttasks/spaces",
      home: undefined,
    });
    // An account with no entry in the user database falls back to HOME.
    expect(resolveLayout(facts("linux", { HOME: "/home/x" }, undefined)).state).toBe(
      "/home/x/.ttasks/state",
    );
  });

  test("Windows: data under %USERPROFILE%\\.ttasks, the program under .local, never AppData", () => {
    const layout = resolveLayout(
      facts(
        "win32",
        {
          USERPROFILE: "C:\\Users\\mira",
          APPDATA: "C:\\Users\\mira\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local",
          TEMP: "C:\\Users\\mira\\AppData\\Local\\Temp",
        },
        "C:\\Users\\other",
      ),
    );
    expect(layout.root).toBe("C:\\Users\\mira\\.local\\share\\ttasks");
    expect(layout.bin).toBe("C:\\Users\\mira\\.local\\bin");
    expect(layout.data).toBe("C:\\Users\\mira\\.ttasks");
    expect(layout.config).toBe("C:\\Users\\mira\\.ttasks\\config");
    expect(layout.state).toBe("C:\\Users\\mira\\.ttasks\\state");
    expect(layout.cache).toBe("C:\\Users\\mira\\.ttasks\\cache");
    expect(layout.logs).toBe("C:\\Users\\mira\\.ttasks\\state\\logs");
    expect(layout.crash).toBe("C:\\Users\\mira\\.ttasks\\state\\crash");
    expect(layout.spaces).toBe("C:\\Users\\mira\\.ttasks\\spaces");
    for (const path of Object.values(layout)) {
      if (typeof path === "string") expect(path.toLowerCase()).not.toContain("appdata");
    }
  });

  test("macOS: the same two places as Linux, no Library folders", () => {
    const layout = resolveLayout(facts("darwin", { HOME: "/tmp/sandbox" }, "/Users/mira", 501));
    expect(layout.root).toBe("/Users/mira/.local/share/ttasks");
    expect(layout.bin).toBe("/Users/mira/.local/bin");
    expect(layout.state).toBe("/Users/mira/.ttasks/state");
    expect(layout.config).toBe("/Users/mira/.ttasks/config");
    expect(layout.cache).toBe("/Users/mira/.ttasks/cache");
    expect(layout.logs).toBe("/Users/mira/.ttasks/state/logs");
  });

  test("the program is never inside the data folder, nor the data inside the program's; spaces are valid", () => {
    for (const layout of [
      resolveLayout(facts("linux", {}, "/home/mira", 1000)),
      resolveLayout(facts("darwin", {}, "/Users/mira", 501)),
      resolveLayout(facts("win32", { USERPROFILE: "C:\\Users\\mira" }, undefined)),
    ]) {
      const sep = layout.platform === "win32" ? "\\" : "/";
      for (const program of [layout.root, layout.bin]) {
        expect(program.startsWith(layout.data + sep)).toBe(false);
        expect(layout.data.startsWith(program + sep)).toBe(false);
      }
      for (const folder of [layout.config, layout.state, layout.cache, layout.spaces]) {
        expect(folder.startsWith(layout.data + sep)).toBe(true);
      }
      // A space in the default folder passes the space path rules, the hidden `.ttasks` included.
      const space = `${layout.spaces}${sep}work`;
      expect(checkSpacePath(space, layout.platform)).toBe(space);
    }
  });

  test("TTASKS_HOME holds the whole install on every OS, and is refused when relative", () => {
    for (const [platform, home, sep] of [
      ["linux", "/home/mira/ttasks-test", "/"],
      ["darwin", "/Users/mira/ttasks-test", "/"],
      ["win32", "D:\\ttasks-test", "\\"],
    ] as const) {
      const layout = resolveLayout(facts(platform, { TTASKS_HOME: home, ...XDG }, "/home/mira"));
      expect(layout.home).toBe(home);
      expect(layout.root).toBe(home);
      expect(layout.data).toBe(home);
      expect(layout.bin).toBe(`${home}${sep}bin`);
      expect(layout.state).toBe(`${home}${sep}state`);
      expect(layout.config).toBe(`${home}${sep}config`);
      expect(layout.cache).toBe(`${home}${sep}cache`);
      expect(layout.logs).toBe(`${home}${sep}state${sep}logs`);
      expect(layout.spaces).toBe(`${home}${sep}spaces`);
    }
    expect(() =>
      resolveLayout(facts("linux", { TTASKS_HOME: "ttasks-test" }, "/home/mira")),
    ).toThrow(LayoutError);
    // Empty means unset.
    expect(resolveLayout(facts("linux", { TTASKS_HOME: "" }, "/home/mira")).home).toBeUndefined();
    expect(() => resolveLayout(facts("linux", {}, undefined))).toThrow(LayoutError);
  });
});

describe("[A2.3.2.hub.install-id] the install ID", () => {
  test("uses A1's ID alphabet, the same as storage's", () => {
    expect(PATHS_ALPHABET).toBe(ID_ALPHABET);
  });
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("10 characters of A1's alphabet, fixed for a given path", () => {
    const id = installId("/home/mira/.ttasks/state");
    expect(id).toHaveLength(10);
    expect(id).toMatch(new RegExp(`^[${ID_ALPHABET}]+$`));
    expect(isInstallId(id)).toBe(true);
    // Golden: M1.12 names units, Run values and labels with it, so it never drifts. The first
    // 50 bits of SHA-256("ttasks-install\n/home/mira/.ttasks/state"), 5 bits per character.
    expect(id).toBe("7yj6swwdz7");
  });

  test("spellings of one path give one ID: trailing separators and Windows case", () => {
    const linux = installId(canonicalStatePath("/home/mira/.ttasks/state", "linux"));
    expect(installId(canonicalStatePath("/home/mira/.ttasks/state/", "linux"))).toBe(linux);
    expect(installId(canonicalStatePath("/home/mira/.ttasks/state//", "linux"))).toBe(linux);
    // Linux paths keep their case: another case is another folder.
    expect(installId(canonicalStatePath("/home/Mira/.ttasks/state", "linux"))).not.toBe(linux);
    const win = installId(canonicalStatePath("C:\\Users\\Mira\\.ttasks\\state", "win32"));
    expect(installId(canonicalStatePath("c:\\users\\mira\\.TTASKS\\STATE\\", "win32"))).toBe(win);
    expect(installId(canonicalStatePath("C:/Users/Mira/.ttasks/state", "win32"))).toBe(win);
  });

  test("a linked path and its target give one ID; two homes with the same name give two", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kh-id-")));
    made.push(root);
    const real = join(root, "real");
    mkdirSync(join(real, "state"), { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const viaLink = canonicalStatePath(realpathSync.native(join(link, "state")), process.platform);
    const direct = canonicalStatePath(realpathSync.native(join(real, "state")), process.platform);
    expect(installId(viaLink)).toBe(installId(direct));

    const a = installId(canonicalStatePath("/home/mira/a/ttasks-test/state", "linux"));
    const b = installId(canonicalStatePath("/home/mira/b/ttasks-test/state", "linux"));
    expect(a).not.toBe(b);
  });

  test("the ID names the runtime folder, the socket or pipe and the launch folders", () => {
    const usable = (dir: string) => dir === "/run/user/1000";
    const homes = ["/home/mira/a/ttasks-test", "/home/mira/b/ttasks-test"];
    const linux = homes.map((home) => {
      const layout = resolveLayout(facts("linux", { TTASKS_HOME: home, ...XDG }, "/home/mira"));
      const id = installId(canonicalStatePath(layout.state, "linux"));
      return { id, names: runtimeNames(layout, id, { platform: "linux", uid: 1000 }, usable) };
    });
    for (const { id, names } of linux) {
      expect(names.runtimeDir).toBe(`/run/user/1000/ttasks-${id}`);
      expect(names.endpoint).toEqual({
        kind: "unix",
        dir: `/run/user/1000/ttasks-${id}`,
        path: `/run/user/1000/ttasks-${id}/tasks.sock`,
        runtime: "run-user",
      });
      expect(names.launch).toBe(`/run/user/1000/ttasks-${id}/launch`);
    }
    expect(linux[0]?.names.runtimeDir).not.toBe(linux[1]?.names.runtimeDir);

    // Without a private /run/user/<uid>: the socket and the launch folders go under <state>.
    const layout = resolveLayout(facts("linux", { TTASKS_HOME: "/h" }, "/home/mira"));
    const id = installId(canonicalStatePath(layout.state, "linux"));
    expect(runtimeNames(layout, id, { platform: "linux", uid: 1000 }, () => false)).toEqual({
      endpoint: {
        kind: "unix",
        dir: "/h/state/run",
        path: "/h/state/run/tasks.sock",
        runtime: "state",
      },
      launch: "/h/state/launch",
      runtimeDir: undefined,
    });
    // macOS always uses <state>/run/.
    const mac = runtimeNames(layout, id, { platform: "darwin", uid: 501 }, () => true);
    expect(mac.endpoint).toMatchObject({ path: "/h/state/run/tasks.sock", runtime: "state" });

    // Windows: the pipe carries the install ID, then the instance ID of each start.
    const pipes = homes.map((home) => {
      const win = resolveLayout(
        facts("win32", { TTASKS_HOME: `C:${home.replaceAll("/", "\\")}` }, undefined),
      );
      const winId = installId(canonicalStatePath(win.state, "win32"));
      const names = runtimeNames(win, winId, { platform: "win32", uid: undefined }, () => true);
      expect(names.launch).toBe(`${win.state}\\launch`);
      if (names.endpoint.kind !== "pipe") throw new Error("expected a pipe");
      return { winId, name: pipeName(names.endpoint, "9c4e1f07a2d35b8e6f10c2a94d7b3e51") };
    });
    for (const { winId, name } of pipes) {
      expect(name).toBe(`\\\\.\\pipe\\ttasks-${winId}-9c4e1f07a2d35b8e6f10c2a94d7b3e51`);
    }
    expect(pipes[0]?.name).not.toBe(pipes[1]?.name);
  });
});
