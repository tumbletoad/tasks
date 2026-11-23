// TTAM's snapshot lines read into TTasks's shapes: every recorded snapshot whole, an unknown value
// kept as unknown, a field TTasks reads in another shape refused. Fixture data only.
import { readFileSync } from "node:fs";
import { TTAM_CONVERSATIONS } from "@ttasks/testkit";
import { describe, expect, test } from "vitest";
import { readLine, readSnapshot, ShapeError } from "./lines.ts";

type Obj = Record<string, unknown>;

/** The snapshot lines TTAM wrote in a recorded conversation, parsed. */
function recorded(file: string): Obj[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { from: string; line?: string })
    .flatMap((r) => (r.from === "ttam" && r.line !== undefined ? [JSON.parse(r.line) as Obj] : []))
    .filter((line) => line["type"] === "snapshot");
}

const ALL = [...recorded(TTAM_CONVERSATIONS.on), ...recorded(TTAM_CONVERSATIONS.off)];
const LAST = recorded(TTAM_CONVERSATIONS.on).at(-1) ?? {};

/** `line` with `change` applied to a deep copy of its snapshot. */
function changed(line: Obj, change: (snapshot: Obj) => void): Obj {
  const copy = structuredClone(line);
  change(copy["snapshot"] as Obj);
  return copy;
}

const agentsOf = (line: Obj) => (line["snapshot"] as Obj)["agents"] as Obj[];
const accountsOf = (line: Obj) => (line["snapshot"] as Obj)["account_usage"] as Obj[];

describe("[A5.agents.monitor-lines] TTAM's lines read into TTasks's snapshot", () => {
  test("every recorded snapshot reads whole: each home, agent and account, none dropped", () => {
    expect(ALL.length).toBeGreaterThan(4);
    for (const line of ALL) {
      const wire = line["snapshot"] as Obj;
      const read = readSnapshot(line, 4);
      expect(read.settling).toBe(line["settling"]);
      expect(read.usage).toBe(line["usage"]);
      expect(read.generation).toBe(wire["generation"]);
      expect(read.homes.map((h) => h.id)).toEqual((wire["homes"] as Obj[]).map((h) => h["id"]));
      expect(read.agents.map((a) => a.rowId)).toEqual(agentsOf(line).map((a) => a["row_id"]));
      expect(read.accounts.map((a) => a.homeId)).toEqual(accountsOf(line).map((a) => a["home_id"]));
    }
  });

  test("a provider TTasks does not know is shown by its name, with its home and account", () => {
    const read = readSnapshot(LAST, 4);
    const agent = read.agents.find((a) => a.providerName === "example");
    expect(agent).toMatchObject({ provider: "unknown", kind: "session", activity: "idle" });
    expect(read.homes.find((h) => h.providerName === "example")?.provider).toBe("unknown");
    expect(read.accounts.find((a) => a.providerName === "example")?.provider).toBe("unknown");
    expect(read.agents.find((a) => a.providerName === "claude")?.provider).toBe("claude");
  });

  test("an unknown enum value is unknown and its row stays; an unknown field is ignored", () => {
    const line = changed(LAST, (s) => {
      const [first] = s["agents"] as Obj[];
      Object.assign(first ?? {}, {
        activity: "pondering",
        kind: "swarm",
        liveness: "rumoured",
        future_field: { nested: [1, 2] },
      });
      const [account] = s["account_usage"] as Obj[];
      const [window] = (account?.["windows"] ?? []) as Obj[];
      Object.assign(window ?? {}, { kind: "fortnightly" });
      s["new_top_level"] = "ignored";
    });
    const read = readSnapshot({ ...line, usage: "sometimes", extra: true }, 4);
    expect(read.agents).toHaveLength(agentsOf(LAST).length);
    expect(read.agents[0]).toMatchObject({
      activity: "unknown",
      kind: "unknown",
      liveness: "unknown",
    });
    expect(read.accounts[0]?.windows[0]?.kind).toBe("unknown");
    expect(read.usage).toBe("unknown");
  });

  test("a field TTasks reads in another shape, or missing, refuses the whole snapshot", () => {
    const broken: ((s: Obj) => void)[] = [
      (s) => {
        s["agents"] = {};
      },
      (s) => {
        delete (agentsOf({ snapshot: s })[0] ?? {})["conversation"];
      },
      (s) => {
        (agentsOf({ snapshot: s })[0] ?? {})["started_at_ms"] = "yesterday";
      },
      (s) => {
        (accountsOf({ snapshot: s })[0] ?? {})["status"] = null;
      },
      (s) => {
        s["schema_version"] = 5;
      },
    ];
    for (const change of broken) {
      expect(() => readSnapshot(changed(LAST, change), 4)).toThrow(ShapeError);
    }
  });

  test("ages are taken inside one snapshot, never below zero, and unknown when a time is", () => {
    const line = changed(LAST, (s) => {
      const captured = s["captured_at_ms"] as number;
      const [a, b, c] = s["agents"] as Obj[];
      Object.assign(a ?? {}, { started_at_ms: captured - 5_000, last_activity_ms: captured - 1 });
      Object.assign(b ?? {}, { started_at_ms: captured + 9_000, last_activity_ms: null });
      Object.assign(c ?? {}, { started_at_ms: null });
    });
    const [a, b, c] = readSnapshot(line, 4).agents;
    expect(a).toMatchObject({ ageMs: 5_000, quietMs: 1 });
    expect(b).toMatchObject({ ageMs: 0, quietMs: null });
    expect(c?.ageMs).toBeNull();
  });

  test("a line is read by its type; one that is no JSON object is no line", () => {
    expect(
      readLine('{"type":"hello","version":"1","build":null,"schema_version":4,"query_version":1}'),
    ).toMatchObject({ type: "hello", schemaVersion: 4, queryVersion: 1, build: { version: "1" } });
    expect(readLine('{"type":"later","x":1}')).toEqual({ type: "other" });
    expect(readLine("not json")).toBeUndefined();
    expect(readLine("[1,2]")).toBeUndefined();
  });
});
