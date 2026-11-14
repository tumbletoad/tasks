import { describe, expect, test } from "vitest";
import {
  detectIdentity,
  integrityLevel,
  INTEGRITY,
  packageIdentity,
  system32Of,
} from "./identity.ts";

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

  test("package identity is the launcher's TASKS_PACKAGE, any non-empty value", () => {
    expect(packageIdentity({})).toBeNull();
    expect(packageIdentity({ TASKS_PACKAGE: "" })).toBeNull();
    expect(packageIdentity({ TASKS_PACKAGE: "  " })).toBeNull();
    expect(packageIdentity({ TASKS_PACKAGE: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc" })).toBe(
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

  test("whoami comes from the System32 the loader used, whatever SystemRoot and windir say", () => {
    expect(
      system32Of(["C:\\Program Files\\nodejs\\node.exe", "C:\\WINDOWS\\SYSTEM32\\ntdll.dll"]),
    ).toBe("C:\\WINDOWS\\SYSTEM32");
    // Only a module named exactly ntdll.dll counts.
    expect(system32Of(["C:\\Users\\mira\\ntdll.dll.bak", "C:\\x\\myntdll.dll"])).toBeUndefined();
    expect(system32Of([])).toBeUndefined();
    if (process.platform !== "win32") return;
    // A parent that points the variables elsewhere changes nothing: the check still runs.
    const identity = detectIdentity(
      { SystemRoot: "C:\\nowhere", windir: "C:\\nowhere" },
      process.platform,
    );
    expect(typeof identity.elevated).toBe("boolean");
    const saved = { SystemRoot: process.env["SystemRoot"], windir: process.env["windir"] };
    try {
      process.env["SystemRoot"] = "C:\\nowhere";
      process.env["windir"] = "C:\\nowhere";
      expect(typeof detectIdentity(process.env, "win32").elevated).toBe("boolean");
    } finally {
      process.env["SystemRoot"] = saved.SystemRoot;
      process.env["windir"] = saved.windir;
    }
  });
});
