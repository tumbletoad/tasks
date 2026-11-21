import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  detectIdentity,
  integrityLevel,
  INTEGRITY,
  packageIdentity,
  system32,
} from "./identity.ts";

const WORKERS_ENTRY = fileURLToPath(
  new URL("../../test/system32-workers-entry.ts", import.meta.url),
);

// The shape of `whoami /groups /fo csv /nh`: name, type, SID, attributes. Names are localised,
// SIDs are not.
const row = (name: string, type: string, sid: string, attrs = "") =>
  `"${name}","${type}","${sid}","${attrs}"`;
const GROUPS = [
  row("Everyone", "Well-known group", "S-1-1-0", "Mandatory group, Enabled by default"),
  row("BUILTIN\\Administrators", "Alias", "S-1-5-32-544", "Group used for deny only"),
  row("NT AUTHORITY\\INTERACTIVE", "Well-known group", "S-1-5-4", "Mandatory group"),
];

describe("[A2.3.3.hub.refusals] who the service runs as", () => {
  test("the integrity level is read from the mandatory label's SID, in any language", () => {
    const sample = (label: string, sid: string) =>
      [...GROUPS, row(label, "Label", sid)].join("\r\n");
    expect(integrityLevel(sample("Mandatory Label\\Medium Mandatory Level", "S-1-16-8192"))).toBe(
      INTEGRITY.medium,
    );
    expect(integrityLevel(sample("Verplicht label\\Hoog verplicht niveau", "S-1-16-12288"))).toBe(
      INTEGRITY.high,
    );
    expect(integrityLevel(sample("Mandatory Label\\System Mandatory Level", "S-1-16-16384"))).toBe(
      INTEGRITY.system,
    );
    // No label, or two: cannot tell.
    expect(integrityLevel(GROUPS.join("\n"))).toBeUndefined();
    expect(
      integrityLevel(
        [...GROUPS, row("a", "Label", "S-1-16-8192"), row("b", "Label", "S-1-16-12288")].join("\n"),
      ),
    ).toBeUndefined();
    // A group name that looks like a label SID does not count: only the SID field does.
    expect(integrityLevel(row("S-1-16-12288", "Group", "S-1-5-21-1-2-3-1001"))).toBeUndefined();
  });

  test("package identity is the launcher's TTASKS_PACKAGE, any non-empty value", () => {
    expect(packageIdentity({})).toBeNull();
    expect(packageIdentity({ TTASKS_PACKAGE: "" })).toBeNull();
    expect(packageIdentity({ TTASKS_PACKAGE: "  " })).toBeNull();
    expect(packageIdentity({ TTASKS_PACKAGE: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc" })).toBe(
      "Claude_1.0.0.0_x64__pzs8sxrjxfjjc",
    );
  });

  test("the real check runs on this machine and gives an answer", () => {
    const identity = detectIdentity({}, process.platform);
    expect(identity.package).toBeNull();
    if (process.platform === "win32") expect(typeof identity.elevated).toBe("boolean");
    else expect(identity.elevated).toBe(false);
    expect(typeof identity.root).toBe("boolean");
  });

  test("whoami comes from the system's own System32, whatever SystemRoot and windir say", () => {
    if (process.platform !== "win32") {
      expect(system32()).toBeUndefined();
      return;
    }
    const saved = { SystemRoot: process.env["SystemRoot"], windir: process.env["windir"] };
    const real = system32();
    expect(real).toBeDefined();
    expect(existsSync(win32.join(real ?? "", "whoami.exe"))).toBe(true);
    try {
      // A parent that points the variables elsewhere changes nothing: the check still runs.
      process.env["SystemRoot"] = "C:\\nowhere";
      process.env["windir"] = "C:\\nowhere";
      expect(system32()).toBe(real);
      expect(typeof detectIdentity(process.env, "win32").elevated).toBe("boolean");
    } finally {
      process.env["SystemRoot"] = saved.SystemRoot;
      process.env["windir"] = saved.windir;
    }
  });
});

describe("[A2.3.3.hub.system32-workers] looking for System32 never ends the process", () => {
  test("a process whose worker threads run, start and end while it looks for System32 runs on", async () => {
    const child = spawn(process.execPath, [WORKERS_ENTRY, "4000"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ...process.env, SystemRoot: "C:\\nowhere", windir: "C:\\nowhere" },
    });
    try {
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", resolve);
      });
      // A diagnostic report taken beside the threads broke the heap: exit 0xC0000374, no output.
      // The folder is the one this process finds, whatever the child's SystemRoot and windir say.
      expect({ code, stderr }).toEqual({
        code: 0,
        stderr: `system32 ${String(system32())}, workers ran\n`,
      });
    } finally {
      child.kill();
    }
  }, 60_000);
});
