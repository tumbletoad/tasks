// `setup/seen` (A3 3.14 `live`; M4.05): the calls the service carried out per instance, and per
// working folder, so `tasks doctor --live` tells its own run's call from another session's.
import { describe, expect, test } from "vitest";
import { SeenCalls } from "./agent-homes.ts";

describe("[A3.3.14.doctor.live] the calls the service saw, by instance and by the run's folder", () => {
  test("a call from another folder of the same instance is no evidence for this run's folder", () => {
    let now = 1_000;
    const seen = new SeenCalls(() => now, "linux");
    seen.saw("claude", "claude-code", "/work/other-session");
    now = 2_000;
    seen.saw("codex", "codex", "/state/tmp/doctor-live-1");
    const [claude, codex] = seen.list(["/state/tmp/doctor-live-1"]);
    expect(claude).toMatchObject({ instance: "claude", app: "claude-code", folder_at: null });
    expect(codex).toMatchObject({ instance: "codex", folder_at: new Date(2_000).toISOString() });
    // Without folders: only each instance's last call.
    expect(seen.list()[0]).not.toHaveProperty("folder_at");
    // A later call from another folder keeps the run's folder's own time.
    now = 3_000;
    seen.saw("codex", "codex", "/work/elsewhere");
    expect(seen.list(["/state/tmp/doctor-live-1"]).at(-1)).toMatchObject({
      at: new Date(3_000).toISOString(),
      folder_at: new Date(2_000).toISOString(),
    });
  });

  test("folders compare as the OS compares paths; the lists are bounded; bad instances are not kept", () => {
    const windows = new SeenCalls(() => 5, "win32");
    windows.saw("claude", "claude-code", "C:\\State\\Tmp\\Run");
    expect(windows.list(["c:\\state\\tmp\\run"])[0]?.folder_at).not.toBeNull();
    const linux = new SeenCalls(() => 5, "linux");
    linux.saw("claude", "claude-code", "/State/run");
    expect(linux.list(["/state/run"])[0]?.folder_at).toBeNull();

    const many = new SeenCalls(() => 1, "linux");
    for (let i = 0; i < 300; i += 1) many.saw(`codex-${String(i)}`, "codex", `/f/${String(i)}`);
    expect(many.list()).toHaveLength(256);
    for (let i = 0; i < 20; i += 1) many.saw("codex-299", "codex", `/g/${String(i)}`);
    // Only the latest eight folders of one instance are kept.
    expect(many.list(["/g/11"]).find((c) => c.instance === "codex-299")?.folder_at).toBeNull();
    expect(many.list(["/g/12"]).find((c) => c.instance === "codex-299")?.folder_at).not.toBeNull();

    many.saw("../not an id", "codex", "/x");
    many.saw(undefined, "codex", "/x");
    expect(many.list().some((c) => c.instance.includes(" "))).toBe(false);
  });
});
