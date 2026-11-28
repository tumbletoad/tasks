// Golden URLs per OS for the best-effort app links:
// Claude Desktop's `claude://code/new?folder=&q=` and the Codex app's
// `codex://threads/new?path=&prompt=`, each value percent-encoded once, for a Windows and
// a Linux folder whose name holds what a URL or a shell would read, and the URL handed to the OS's
// opener as one argv element. No real opener runs and no app is started. Fixture data only.
import { describe, expect, test } from "vitest";
import { openUrl } from "../src/opener.ts";
import { expandUrl, routeOf } from "../src/routes/argv.ts";
import type { SpawnRequest, SpawnedProcess } from "../src/terminals/accept.ts";

const WINDOWS_FOLDER = "C:\\Users\\mira\\Work\\R&D #2 (50%+) Café";
const LINUX_FOLDER = "/home/mira/work/R&D #2 (50%+) Café";
const BRIEF = "TTasks task M-14 (launch L7KQ21).\nLook at A & B, 100% + #3.";

const Q =
  "TTasks%20task%20M-14%20%28launch%20L7KQ21%29.%0ALook%20at%20A%20%26%20B%2C%20100%25%20%2B%20%233.";
const WIN = "C%3A%5CUsers%5Cmira%5CWork%5CR%26D%20%232%20%2850%25%2B%29%20Caf%C3%A9";
const LIN = "%2Fhome%2Fmira%2Fwork%2FR%26D%20%232%20%2850%25%2B%29%20Caf%C3%A9";

const GOLDEN = {
  "claude-desktop": {
    win32: `claude://code/new?folder=${WIN}&q=${Q}`,
    linux: `claude://code/new?folder=${LIN}&q=${Q}`,
  },
  "codex-app": {
    win32: `codex://threads/new?path=${WIN}&prompt=${Q}`,
    linux: `codex://threads/new?path=${LIN}&prompt=${Q}`,
  },
} as const;

/** A spawner that records each request and answers that the opener exited 0. */
function recorder(): {
  spawn: (r: SpawnRequest) => Promise<SpawnedProcess>;
  calls: SpawnRequest[];
} {
  const calls: SpawnRequest[] = [];
  return {
    calls,
    spawn: (request) => {
      calls.push(request);
      return Promise.resolve({
        pid: 4242,
        exited: Promise.resolve({ code: 0, signal: null }),
        stop: () => undefined,
      });
    },
  };
}

describe("[A4.5.routes.golden-urls] the best-effort app links: golden URLs per OS, one element", () => {
  for (const target of ["claude-desktop", "codex-app"] as const) {
    test(`${target}: the golden URL on Windows and on Linux, whose values decode back exactly`, async () => {
      const route = routeOf(target, "link");
      expect(route).toMatchObject({
        kind: "link",
        prompt: "prefilled",
        budget: 2_000,
        copyBriefToo: true,
        confirmFolder: true,
      });
      const template = route?.url ?? "";
      const [folderKey, briefKey] =
        target === "claude-desktop" ? ["folder", "q"] : ["path", "prompt"];
      for (const [platform, folder] of [
        ["win32", WINDOWS_FOLDER],
        ["linux", LINUX_FOLDER],
      ] as const) {
        const url = expandUrl(template, { cwd: folder, brief: BRIEF });
        expect(url).toBe(GOLDEN[target][platform]);
        // Only characters that need no further quoting anywhere: one argv element as it is.
        expect(url).toMatch(/^[a-z]+:\/\/[A-Za-z0-9/?&=%._~-]+$/u);
        const query = new URL(url).searchParams;
        expect([...query.keys()]).toEqual([folderKey, briefKey]);
        expect(query.get(folderKey)).toBe(folder);
        expect(query.get(briefKey)).toBe(BRIEF);

        // The OS's opener gets the URL as one element.
        const r = recorder();
        const opened = await openUrl(url, {
          platform,
          env: platform === "win32" ? { SystemRoot: "C:\\Windows" } : { DISPLAY: ":0" },
          spawn: r.spawn,
          which: (name) => (name === "gio" ? "/usr/bin/gio" : undefined),
          cwd: platform === "win32" ? "C:\\Users\\mira" : "/home/mira",
          timeoutMs: 1_000,
        });
        expect(opened.result).toBe("opened");
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0]?.argv).toEqual(
          platform === "win32"
            ? ["C:\\Windows\\System32\\rundll32.exe", "url.dll,FileProtocolHandler", url]
            : ["/usr/bin/gio", "open", url],
        );
      }
    });
  }
});
