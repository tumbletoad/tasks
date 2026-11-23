// The OS's URL opener (A4 3.6.5) over a recording spawner: which program gets the URL as one
// argv element on each OS, what each outcome means for the launch, and that a fallback runs only
// when the opener before it never started, so one launch never opens a URL twice. No real opener
// runs and no real link is opened. Fixture data only.
import { describe, expect, test, vi } from "vitest";
import { PRODUCT_ID } from "@ttasks/brand";
import { openFolder, openUrl, type OpenerOptions } from "../src/opener.ts";
import { DEFAULT_TERMINAL } from "../src/sections.ts";
import type { SpawnRequest, SpawnedProcess } from "../src/terminals/accept.ts";
import { TerminalLauncher } from "../src/terminals/launcher.ts";

const URL_ = "claude-cli://open?cwd=%2Fhome%2Fmira%2Fwork&q=TTasks%20task%20M-14";

/** A spawner that records each request and answers as `answers` says, by program. */
function recorder(answers: Record<string, number | "missing" | "hang">): {
  spawn: OpenerOptions["spawn"];
  calls: SpawnRequest[];
  stopped: string[];
} {
  const calls: SpawnRequest[] = [];
  const stopped: string[] = [];
  const spawn = (request: SpawnRequest): Promise<SpawnedProcess> => {
    calls.push(request);
    const program = request.argv[0] ?? "";
    const answer = answers[program] ?? "missing";
    if (answer === "missing") {
      return Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    }
    let release!: (exit: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      release = resolve;
    });
    if (answer !== "hang") release({ code: answer, signal: null });
    return Promise.resolve({
      pid: 4242,
      exited,
      stop: () => {
        stopped.push(program);
        release({ code: null, signal: "SIGKILL" });
      },
    });
  };
  return { spawn, calls, stopped };
}

const linux = (
  answers: Record<string, number | "missing" | "hang">,
  env: Record<string, string> = { DISPLAY: ":0" },
  deadline: "short" | "default" = "short",
) => {
  const r = recorder(answers);
  const options: OpenerOptions = {
    platform: "linux",
    env,
    spawn: r.spawn,
    which: (name) => (name in { gio: 1, "xdg-open": 1 } ? `/usr/bin/${name}` : undefined),
    cwd: "/home/mira",
    ...(deadline === "short" ? { timeoutMs: 200 } : {}),
  };
  return { r, options };
};

describe("[A4.5.routes.opener] the OS's URL opener: one element, defined outcomes, never two opens", () => {
  test("Windows: rundll32's FileProtocolHandler with the URL as one element; explorer only when rundll32 never started", async () => {
    const r = recorder({ "C:\\Windows\\System32\\rundll32.exe": 1 });
    const options: OpenerOptions = {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn: r.spawn,
      cwd: "C:\\Users\\mira",
    };
    // rundll32 gives no useful code: once it ran, the URL went to ShellExecute.
    expect(await openUrl(URL_, options)).toEqual({ result: "opened", opener: "rundll32" });
    expect(r.calls.map((c) => c.argv)).toEqual([
      ["C:\\Windows\\System32\\rundll32.exe", "url.dll,FileProtocolHandler", URL_],
    ]);
    const missing = recorder({ "C:\\Windows\\explorer.exe": 1 });
    expect(await openUrl(URL_, { ...options, spawn: missing.spawn })).toEqual({
      result: "opened",
      opener: "explorer",
    });
    expect(missing.calls.map((c) => c.argv)).toEqual([
      ["C:\\Windows\\System32\\rundll32.exe", "url.dll,FileProtocolHandler", URL_],
      ["C:\\Windows\\explorer.exe", URL_],
    ]);
    const none = recorder({});
    expect(await openUrl(URL_, { ...options, spawn: none.spawn })).toEqual({
      result: "not_started",
      opener: "none",
    });
  });

  test("Linux: gio open in the session; xdg-open only when gio is missing; its codes 3 and 4 say no handler", async () => {
    const ok = linux({ "/usr/bin/gio": 0 });
    expect(await openUrl(URL_, ok.options)).toEqual({ result: "opened", opener: "gio" });
    expect(ok.r.calls.map((c) => c.argv)).toEqual([["/usr/bin/gio", "open", URL_]]);
    expect(ok.r.calls[0]?.env).toEqual({ DISPLAY: ":0" });

    // A gio that failed may have handed the URL on: unknown, and xdg-open is never tried.
    const failed = linux({ "/usr/bin/gio": 2, "/usr/bin/xdg-open": 0 });
    expect(await openUrl(URL_, failed.options)).toEqual({ result: "unknown", opener: "gio" });
    expect(failed.r.calls).toHaveLength(1);

    for (const [code, result] of [
      [0, "opened"],
      [3, "no_handler"],
      [4, "no_handler"],
      [1, "unknown"],
    ] as const) {
      const xdg = linux({ "/usr/bin/xdg-open": code });
      expect(await openUrl(URL_, xdg.options)).toEqual({ result, opener: "xdg-open" });
      expect(xdg.r.calls.map((c) => c.argv[0])).toEqual(["/usr/bin/gio", "/usr/bin/xdg-open"]);
    }
  });

  test("Linux without a display: no session, and nothing starts", async () => {
    const none = linux({ "/usr/bin/gio": 0 }, {});
    expect(await openUrl(URL_, none.options)).toEqual({ result: "no_session", opener: "none" });
    expect(none.r.calls).toEqual([]);
    const wayland = linux({ "/usr/bin/gio": 0 }, { WAYLAND_DISPLAY: "wayland-0" });
    expect((await openUrl(URL_, wayland.options)).result).toBe("opened");
  });

  test("a folder goes to the file manager: on Windows as its file URL, so a comma or a space stays in its name", async () => {
    const r = recorder({ "C:\\Windows\\System32\\rundll32.exe": 1 });
    const options: OpenerOptions = {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn: r.spawn,
      cwd: "C:\\Users\\mira",
    };
    const folder = "C:\\work\\lumen\\portal, old #2";
    expect(await openFolder(folder, options)).toEqual({ result: "opened", opener: "rundll32" });
    expect(r.calls.map((c) => c.argv)).toEqual([
      [
        "C:\\Windows\\System32\\rundll32.exe",
        "url.dll,FileProtocolHandler",
        "file:///C:/work/lumen/portal,%20old%20%232",
      ],
    ]);
    const explorer = recorder({ "C:\\Windows\\explorer.exe": 1 });
    expect(await openFolder(folder, { ...options, spawn: explorer.spawn })).toEqual({
      result: "opened",
      opener: "explorer",
    });
    expect(explorer.calls.at(-1)?.argv).toEqual(["C:\\Windows\\explorer.exe", folder]);

    const posix = linux({ "/usr/bin/gio": 0 });
    expect(await openFolder("/home/mira/work/portal", posix.options)).toEqual({
      result: "opened",
      opener: "gio",
    });
    expect(posix.r.calls.map((c) => c.argv)).toEqual([
      ["/usr/bin/gio", "open", "/home/mira/work/portal"],
    ]);
    const headless = linux({ "/usr/bin/gio": 0 }, {});
    expect((await openFolder("/home/mira/work/portal", headless.options)).result).toBe(
      "no_session",
    );
  });

  test("macOS: a folder is shown in Finder, never opened, so an application bundle is not started", async () => {
    for (const folder of ["/Users/mira/work/portal", "/Users/mira/work/build/Lumen.app"]) {
      const r = recorder({ "/usr/bin/open": 0 });
      const options: OpenerOptions = {
        platform: "darwin",
        env: {},
        spawn: r.spawn,
        cwd: "/Users/mira",
      };
      expect(await openFolder(folder, options)).toEqual({ result: "opened", opener: "open" });
      expect(r.calls.map((c) => c.argv)).toEqual([["/usr/bin/open", "-R", folder]]);
    }
  });

  test("an opener is never tied to the service: detached on every OS, and on Linux in a scope of its own when scopes work, so a stop or update of the service leaves what it opened", async () => {
    // Windows: outside the kill-on-close job a normal child is in. macOS: a session of its own.
    for (const [platform, program, env] of [
      ["win32", "C:\\Windows\\System32\\rundll32.exe", { SystemRoot: "C:\\Windows" }],
      ["darwin", "/usr/bin/open", {}],
    ] as const) {
      const r = recorder({ [program]: 0 });
      const options = { platform, env, spawn: r.spawn, cwd: "/" };
      expect((await openFolder("/work", options)).result).toBe("opened");
      expect((await openUrl(URL_, options)).result).toBe("opened");
      expect(r.calls.map((c) => [c.argv[0], c.detached])).toEqual([
        [program, true],
        [program, true],
      ]);
    }

    // Linux: the service's unit ends every process in it when it stops or updates. The launcher
    // the service has decides: a scope when its probe says scopes work, else detached only.
    const linuxWith = async (probe: number) => {
      const r = recorder({ "/usr/bin/gio": 0, "/usr/bin/systemd-run": probe });
      const launcher = new TerminalLauncher({
        platform: "linux",
        settings: DEFAULT_TERMINAL,
        install: "0123456789",
        shimCommand: ["/opt/ttasks/bin/ttasks"],
        host: () => Promise.reject(new Error("an opener reads no terminal")),
        systemdRun: "/usr/bin/systemd-run",
        trueProgram: "/usr/bin/true",
        spawn: r.spawn,
      });
      const { options } = linux({});
      const env = { DISPLAY: ":0" };
      const opener: OpenerOptions = {
        ...options,
        spawn: r.spawn,
        outside: (argv) => launcher.outside(env, argv),
      };
      expect(await openFolder("/home/mira/work", opener)).toEqual({
        result: "opened",
        opener: "gio",
      });
      expect(await openUrl(URL_, opener)).toEqual({ result: "opened", opener: "gio" });
      return r.calls;
    };
    const scoped = await linuxWith(0);
    expect(scoped.map((c) => c.argv.slice(0, 5))).toEqual([
      ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--quiet"],
      ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--slice=app.slice"],
      ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--slice=app.slice"],
    ]);
    const [folderCall, urlCall] = scoped.slice(1);
    expect(folderCall?.argv.slice(5)).toEqual([
      expect.stringMatching(new RegExp(`^--unit=${PRODUCT_ID}-0123456789-open-[0-9a-f]{16}$`, "u")),
      "--",
      "/usr/bin/gio",
      "open",
      "/home/mira/work",
    ]);
    expect(urlCall?.argv.slice(6)).toEqual(["--", "/usr/bin/gio", "open", URL_]);
    // Each opener its own unit, so a second one never meets the first while systemd collects it.
    expect(urlCall?.argv[5]).not.toBe(folderCall?.argv[5]);
    expect(scoped.every((c) => c.detached)).toBe(true);

    const unscoped = await linuxWith(1);
    expect(unscoped.map((c) => [c.argv[0], c.detached])).toEqual([
      ["/usr/bin/systemd-run", true],
      ["/usr/bin/gio", true],
      ["/usr/bin/gio", true],
    ]);
  });

  test("an opener that does not end in time is left running: the wait ends, its answer is unknown, and no other opener is tried", async () => {
    // xdg-open may stay with the application it started, in its process group: ending it could
    // end that application, with the person's work in it.
    const fallback = linux({ "/usr/bin/xdg-open": "hang" });
    expect(await openUrl(URL_, fallback.options)).toEqual({
      result: "unknown",
      opener: "xdg-open",
    });
    expect(fallback.r.stopped).toEqual([]);
    // gio may still open it: xdg-open would open a second copy.
    const hung = linux({ "/usr/bin/gio": "hang", "/usr/bin/xdg-open": 0 });
    expect(await openFolder("/home/mira/work", hung.options)).toEqual({
      result: "unknown",
      opener: "gio",
    });
    expect(hung.r.calls.map((c) => c.argv[0])).toEqual(["/usr/bin/gio"]);
    expect(hung.r.stopped).toEqual([]);
  });

  test("with no deadline given, an opener gets 10 s: no answer at 9,999 ms, unknown at 10,000 ms, and never stopped", async () => {
    const hung = linux({ "/usr/bin/xdg-open": "hang" }, undefined, "default");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer: unknown;
      const asked = openUrl(URL_, hung.options).then((opened) => (answer = opened));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await asked;
      expect(answer).toEqual({ result: "unknown", opener: "xdg-open" });
      expect(hung.r.stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
