// The built-in target catalogue (A4 3.2): reviewed data whose invariants hold for every entry, and
// the permission flags of A4 3.11.6 exactly.
import { describe, expect, test } from "vitest";
import {
  BUILT_IN_TARGETS,
  CATALOGUE,
  checkArgvTemplate,
  checkUrlTemplate,
  inTestedRange,
  targetDef,
  versionIn,
} from "../src/catalogue.ts";

describe("[A4.3.2.catalogue.invariants] the built-in target catalogue", () => {
  test("each built-in target once, routes well-formed, templates within A4 3.6.4, budgets within limits", () => {
    expect(CATALOGUE.map((t) => t.id)).toEqual([...BUILT_IN_TARGETS]);
    for (const target of CATALOGUE) {
      expect(target.routes.length, target.id).toBeGreaterThan(0);
      expect(target.glyph).toMatch(/^[A-Z][a-z0-9]$|^T3$/u);
      for (const route of target.routes) {
        if (route.maxPrompt !== null) expect(route.budget).toBeLessThanOrEqual(route.maxPrompt);
        if (route.argv !== undefined) expect(checkArgvTemplate(route.argv), target.id).toEqual([]);
        if (route.url !== undefined) expect(checkUrlTemplate(route.url), target.id).toEqual([]);
        if (route.kind === "link") expect(route.url).toBeDefined();
        if (route.kind === "terminal") expect(route.argv?.[0]).toBe("{exec}");
        // A sent prompt in argv always follows `--`, so a brief is never read as an option.
        if (route.kind === "terminal" && route.prompt === "sent") {
          expect(route.argv?.slice(-2)).toEqual(["--", "{brief}"]);
        }
      }
      if (target.testedVersions !== "")
        expect(inTestedRange("0.0.0", target.testedVersions)).toBe(false);
    }
  });

  test("A4 3.11.6's permission flags; inherit adds nothing, and a Codex run takes no flags", () => {
    const claude = targetDef("claude-cli").permissionArgs;
    const codex = targetDef("codex-cli").permissionArgs;
    expect(claude.inherit).toEqual({ open: [], run: null });
    expect(claude["full-access"].open).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(claude["auto-edit"].run).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
    ]);
    expect(claude["read-only"].open).toEqual(["--permission-mode", "plan"]);
    expect(codex.inherit).toEqual({ open: [], run: null });
    expect(codex["full-access"]).toEqual({
      open: ["--dangerously-bypass-approvals-and-sandbox"],
      run: null,
    });
    expect(codex["auto-edit"]).toEqual({
      open: ["-s", "workspace-write", "-a", "on-request"],
      run: null,
    });
    expect(codex["read-only"]).toEqual({
      open: ["-s", "read-only", "-a", "on-request"],
      run: null,
    });
    // Codex's terminal route keeps the session in the shim's process tree (A4 3.4.3).
    expect(targetDef("codex-cli").routes[0]?.argv).toContain("--no-daemon");
  });

  test("template checks refuse unknown placeholders, split whole elements and a brief before --", () => {
    expect(checkArgvTemplate(["{exec}", "--", "{brief}"])).toEqual([]);
    expect(checkArgvTemplate(["{exec}", "{nope}"])).toEqual(["unknown_placeholder"]);
    expect(checkArgvTemplate(["--bin={exec}"])).toEqual(["split_element"]);
    expect(checkArgvTemplate(["{exec}", "{brief}", "--"])).toEqual(["brief_before_separator"]);
    expect(checkArgvTemplate(["{exec}", "-p", "{brief}"])).toEqual(["brief_before_separator"]);
    expect(checkUrlTemplate("x://open?cwd={cwd}&q={brief}")).toEqual([]);
    expect(checkUrlTemplate("x://open?exec={exec}")).toEqual(["unknown_placeholder"]);
  });

  test("versions: the first a.b.c in a command's output, checked against a range of bounds", () => {
    expect(versionIn("2.1.322 (Claude Code)\n")).toBe("2.1.322");
    expect(versionIn("codex-cli 0.166.0")).toBe("0.166.0");
    expect(versionIn("v26.13.1")).toBe("26.13.1");
    expect(versionIn("unknown")).toBeUndefined();
    expect(inTestedRange("0.166.0", ">=0.166.0 <0.200.0")).toBe(true);
    expect(inTestedRange("0.200.0", ">=0.166.0 <0.200.0")).toBe(false);
    expect(inTestedRange("0.165.9", ">=0.166.0 <0.200.0")).toBe(false);
    expect(inTestedRange("1.0.0", "")).toBeUndefined();
    expect(inTestedRange("1.0.0", "~1.0")).toBeUndefined();
  });
});
