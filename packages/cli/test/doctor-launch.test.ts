// `ttasks doctor`'s launch rows and sessions row (A3 3.14; A4 3.4.1, 3.7, 3.8; A7 3.11 M4.05b):
// each row passes and fails against fake answers of the service, and says nothing but words,
// counts, dates and instance IDs. The rows' wiring through a real service is in doctor.test.ts.
import { describe, expect, test } from "vitest";
import type { Session } from "../src/connect.ts";
import {
  environmentCheck,
  launchChecks,
  scopesCheck,
  sessionsCheck,
  t3PairingCheck,
  T3_WARN_MS,
  terminalCheck,
} from "../src/doctor-launch.ts";

const NOW = Date.UTC(2026, 10, 14, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (at: number) => new Date(at).toISOString();

describe("[A3.3.14.doctor.launch] doctor's launch rows against fakes", () => {
  test("launch.scopes: a scope passes, none warns with the fix, other systems skip", () => {
    expect(scopesCheck(true).status).toBe("ok");
    const none = scopesCheck(false);
    expect(none.status).toBe("warn");
    expect(none.detail).toContain("may end the agent sessions");
    expect(none.detail).toContain("ttasks service restart");
    expect(scopesCheck(null).status).toBe("skip");
  });

  test("launch.terminal: names the terminal and its source; a missing one or a default without an adapter warns", () => {
    const row = (terminal: unknown) => terminalCheck(terminal);
    expect(row({ app: "ghostty", source: "desktop", found: true, unsupported: null })).toEqual({
      id: "launch.terminal",
      status: "ok",
      detail: "Terminals open in Ghostty: the desktop's default.",
    });
    expect(row({ app: "kitty", source: "configured", found: true }).detail).toContain(
      "your choice in Settings",
    );
    expect(row({ app: "console", source: "windows", found: true }).detail).toContain(
      "Windows' default terminal",
    );
    const ptyxis = row({
      app: "gnome-terminal",
      source: "installed",
      found: true,
      unsupported: "org.gnome.Ptyxis.desktop",
    });
    expect(ptyxis.status).toBe("warn");
    expect(ptyxis.detail).toContain("(org.gnome.Ptyxis.desktop)");
    expect(ptyxis.detail).toContain("GNOME Terminal (the first installed)");
    expect(ptyxis.detail).toContain("open Settings and pick it under Terminal");
    expect(
      row({ app: "wt", source: "installed", found: true, unsupported: "other" }).detail,
    ).toContain("in Windows' settings");
    // A name that is not plain characters is never shown.
    expect(
      row({ app: "kitty", source: "installed", found: true, unsupported: "/home/x/../y" }).detail,
    ).not.toContain("/home");
    // A setting that could not be read: the terminal is TTasks' fallback, not the default.
    const unreadWindows = row({ app: "wt", source: "installed", found: true, unread: "windows" });
    expect(unreadWindows.status).toBe("warn");
    expect(unreadWindows.detail).toContain(
      "could not read your default terminal in Windows' settings",
    );
    expect(unreadWindows.detail).toContain("Windows Terminal, its fallback");
    expect(unreadWindows.detail).not.toContain("Windows' default terminal");
    const unreadDesktop = row({
      app: "kitty",
      source: "installed",
      found: true,
      unread: "desktop",
    });
    expect(unreadDesktop.status).toBe("warn");
    expect(unreadDesktop.detail).toContain(
      "could not read your desktop's default terminal in time",
    );
    expect(unreadDesktop.detail).toContain("kitty, its fallback");
    expect(row({ app: "wezterm", source: "configured", found: false }).status).toBe("warn");
    expect(row({ app: null, source: null, found: false }).detail).toContain("No terminal");
    // The way to choose one is the page's Settings, never a file to edit by hand.
    for (const terminal of [
      { app: "wezterm", source: "configured", found: false },
      { app: null, source: null, found: false },
      { app: "kitty", source: "installed", found: true, unread: "desktop" },
    ]) {
      const detail = row(terminal).detail;
      expect(detail, JSON.stringify(terminal)).toContain("Settings");
      expect(detail, JSON.stringify(terminal)).not.toContain("machine.toml");
    }
    expect(row(null).status).toBe("skip");
  });

  test("launch.env: a snapshot that succeeded passes; a failed one warns with what launches get", () => {
    const snapshot = (outcome: string | null, attempted: number | null, taken: number | null) => ({
      kind: "snapshot",
      outcome,
      attempted_at: attempted === null ? null : iso(attempted),
      taken_at: taken === null ? null : iso(taken),
    });
    expect(environmentCheck(snapshot("ok", NOW, NOW), NOW)).toEqual(
      expect.objectContaining({ id: "launch.env", status: "ok" }),
    );
    // Nothing attempted since the service started: the stored one's age, or nothing to say yet.
    const kept = environmentCheck(snapshot(null, null, NOW - 2 * HOUR), NOW);
    expect(kept.status).toBe("ok");
    expect(kept.detail).toContain("taken 2 hours ago");
    const nothing = environmentCheck(snapshot(null, null, null), NOW);
    expect(nothing.status).toBe("skip");
    expect(nothing.detail).toContain("doctor --live");
    // A stored snapshot a day old or more is never ok, attempted at this start or not: the next
    // launch takes it again, and only --live says now whether the shell still gives one.
    for (const outcome of [null, "ok"]) {
      const old = environmentCheck(snapshot(outcome, NOW - 3 * DAY, NOW - 3 * DAY), NOW);
      expect([outcome, old.status]).toEqual([outcome, "skip"]);
      expect(old.detail).toContain("3 days ago");
      expect(old.detail).toContain("doctor --live");
    }
    // An attempt that succeeded with no snapshot to show is no pass either.
    expect(environmentCheck(snapshot("ok", NOW, null), NOW).status).toBe("skip");
    // A failed attempt with a snapshot of an hour ago still in use, then a stale one, then none.
    const recent = environmentCheck(snapshot("timeout", NOW - 5 * 60_000, NOW - HOUR), NOW);
    expect(recent.status).toBe("warn");
    expect(recent.detail).toContain("when last asked (5 minutes ago)");
    expect(recent.detail).toContain("within 10 seconds");
    expect(recent.detail).toContain("taken 60 minutes ago");
    expect(recent.detail).not.toContain("stale");
    expect(recent.detail).toContain("doctor --live");
    const stale = environmentCheck(snapshot("no_markers", NOW, NOW - 3 * DAY), NOW);
    expect(stale.detail).toContain("3 days ago, which is stale");
    const none = environmentCheck(snapshot("failed", NOW, null), NOW);
    expect(none.status).toBe("warn");
    expect(none.detail).toContain("the service's own environment");
    // Windows: the registry read, or not.
    expect(environmentCheck({ kind: "registry", read: true }, NOW).status).toBe("ok");
    expect(environmentCheck({ kind: "registry", read: false }, NOW).status).toBe("warn");
    // A fixed environment (tests) is not checked.
    expect(environmentCheck(null, NOW).status).toBe("skip");
  });

  test("launch.t3: a pairing that renews passes; one that cannot warns 5 days before it runs out", () => {
    const paired = (extra: Record<string, unknown>) => ({ state: "ready", ...extra });
    expect(t3PairingCheck(paired({ renews: true, expires_at: iso(NOW + HOUR) }), NOW).status).toBe(
      "ok",
    );
    expect(t3PairingCheck(paired({ renews: false }), NOW).status).toBe("ok");
    // An expiry the service gave but no one can read is not a pass.
    for (const broken of ["broken", "", 12, { at: 1 }]) {
      expect([
        broken,
        t3PairingCheck(paired({ renews: false, expires_at: broken }), NOW).status,
      ]).toEqual([broken, "skip"]);
    }
    // Without `renews` the pairing is judged as one that cannot renew itself.
    expect(t3PairingCheck(paired({ expires_at: iso(NOW + DAY) }), NOW).status).toBe("warn");
    const later = t3PairingCheck(paired({ renews: false, expires_at: iso(NOW + 30 * DAY) }), NOW);
    expect(later).toMatchObject({ status: "ok" });
    expect(later.detail).toContain("until 2026-12-14");
    // Within the window: a warning with the date, the days left and the fix.
    const soon = t3PairingCheck(
      paired({ renews: false, expires_at: iso(NOW + T3_WARN_MS - HOUR) }),
      NOW,
    );
    expect(soon.status).toBe("warn");
    expect(soon.detail).toContain("in 5 days");
    expect(soon.detail).toContain("setup t3");
    expect(
      t3PairingCheck(paired({ renews: false, expires_at: iso(NOW + T3_WARN_MS + HOUR) }), NOW)
        .status,
    ).toBe("ok");
    const gone = t3PairingCheck(paired({ renews: false, expires_at: iso(NOW - DAY) }), NOW);
    expect(gone.status).toBe("warn");
    expect(gone.detail).toContain("ran out on 2026-11-13");
    // T3 not running: the pairing is still judged, and the row says T3 is not running.
    const closed = t3PairingCheck(
      { state: "not_running", renews: false, expires_at: iso(NOW + DAY) },
      NOW,
    );
    expect(closed.status).toBe("warn");
    expect(t3PairingCheck({ state: "not_running", renews: true }, NOW).detail).toContain(
      "not running",
    );
    expect(t3PairingCheck({ state: "reconnect" }, NOW).status).toBe("warn");
    expect(t3PairingCheck({ state: "not_paired" }, NOW).status).toBe("skip");
    expect(t3PairingCheck(undefined, NOW).status).toBe("skip");
  });

  test("the rows from a service: each question asked once, the snapshot taken only with --live, and an older service's silence skips", async () => {
    const asked: [string, unknown][] = [];
    const session = (answers: Record<string, unknown>): Session => ({
      bound: {} as Session["bound"],
      close: () => undefined,
      call: (method: string, params?: Record<string, unknown>) => {
        asked.push([method, params]);
        return method in answers
          ? Promise.resolve(answers[method])
          : Promise.reject(new Error("Method not found"));
      },
    });
    const answers = {
      "doctor/launch": {
        scopes: false,
        terminal: { app: "wt", source: "windows", found: true, unsupported: null },
        environment: {
          kind: "snapshot",
          outcome: "ok",
          attempted_at: iso(NOW),
          taken_at: iso(NOW),
        },
      },
      "t3/status": { state: "not_paired" },
      "doctor/sessions": { open: 2, shared: [], dropped: 0 },
    };
    const rows = await launchChecks(session(answers), false, NOW);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["launch.scopes", "warn"],
      ["launch.terminal", "ok"],
      ["launch.env", "ok"],
      ["launch.t3", "skip"],
      ["sessions", "ok"],
    ]);
    expect(asked.map(([method]) => method).sort()).toEqual([
      "doctor/launch",
      "doctor/sessions",
      "t3/status",
    ]);
    expect(asked.find(([method]) => method === "doctor/launch")?.[1]).toEqual({ take: false });
    asked.length = 0;
    await launchChecks(session(answers), true, NOW);
    expect(asked.find(([method]) => method === "doctor/launch")?.[1]).toEqual({ take: true });
    const older = await launchChecks(session({}), false, NOW);
    expect(older.map((r) => r.status)).toEqual(["skip", "skip", "skip", "skip", "skip"]);
  });
});

describe("[A3.3.14.doctor.sessions] doctor's sessions row against fakes", () => {
  test("no dropped record and no shared connection passes; either warns, by instance only", () => {
    const ok = sessionsCheck({ open: 3, shared: [], dropped: 0 });
    expect(ok).toMatchObject({ id: "sessions", status: "ok" });
    expect(ok.detail).toContain("3 agent connections open");
    const dropped = sessionsCheck({ open: 0, shared: [], dropped: 2 });
    expect(dropped.status).toBe("warn");
    expect(dropped.detail).toContain("2 session records were damaged and dropped");
    const shared = sessionsCheck({
      open: 3,
      shared: [
        { instance: "codex", count: 2 },
        // Anything but an instance ID never reaches the row.
        { instance: "/home/x\u001b[31m", count: 1 },
      ],
      dropped: 0,
    });
    expect(shared.status).toBe("warn");
    expect(shared.detail).toContain(
      "2 agent connections of codex carry more than one conversation",
    );
    expect(shared.detail).not.toContain("/home/x");
    expect(shared.detail).not.toContain("\u001b");
    // Shared connections the row cannot name still warn, unnamed.
    const unnamed = sessionsCheck({
      open: 1,
      shared: [{ instance: "/home/x", count: 1 }],
      dropped: 0,
    });
    expect(unnamed.status).toBe("warn");
    expect(unnamed.detail).toContain("shared mode");
    expect(unnamed.detail).not.toContain("/home/x");
    expect(sessionsCheck(null).status).toBe("skip");
    // Facts the service did not give, or gave in another shape, are never a pass.
    for (const facts of [
      {},
      { open: 1, shared: [] },
      { open: 1, dropped: 0 },
      { open: "1", shared: [], dropped: 0 },
      { open: 1, shared: [], dropped: -1 },
      { open: 1, shared: {}, dropped: 0 },
    ]) {
      expect([facts, sessionsCheck(facts).status]).toEqual([facts, "skip"]);
    }
  });
});
