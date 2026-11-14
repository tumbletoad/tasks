// A2 3.8.2's port rule over injected facts: who holds each port is an injected identity, so the
// other-user cases run on every machine without a second account. A fallback port only when this
// user's own process holds the port; another user's sighting, now or recorded, means no UI.
import { describe, expect, test } from "vitest";
import { HolderCheckFailed, type ForeignHolder } from "./holders.ts";
import { choosePort, PORT_RANGE, retryPort, type BoundListener, type PortFacts } from "./port.ts";

type Holder = "free" | "mine" | "other";

/** A machine of ports, each free, held by this user or by another one. */
function machine(ports: Record<number, Holder>, recorded: Record<number, number> = {}) {
  const log: string[] = [];
  const records: { port: number; holders: readonly ForeignHolder[] }[] = [];
  const persisted: number[] = [];
  let checkFailures = 0;
  let failCheck = false;
  const facts: PortFacts = {
    listen: (port) => {
      log.push(`listen ${String(port)}`);
      if (port === 0) return Promise.resolve(listener(41385));
      return Promise.resolve((ports[port] ?? "free") === "free" ? listener(port) : "taken");
    },
    holders: (port, { bindFailed }) => {
      log.push(`check ${String(port)}${bindFailed ? " after bind" : ""}`);
      if (failCheck) throw new HolderCheckFailed("no answer");
      return ports[port] === "other" ? [{ owner: "1002" }] : [];
    },
    recorded: (port) => Promise.resolve(recorded[port] ?? 0),
    record: (port, holders) => {
      records.push({ port, holders });
      recorded[port] = (recorded[port] ?? 0) + 1;
      return Promise.resolve();
    },
    persist: (port) => {
      persisted.push(port);
      return true;
    },
    checkFailed: () => {
      checkFailures += 1;
    },
  };
  return {
    facts,
    log,
    records,
    persisted,
    set: (port: number, holder: Holder) => {
      ports[port] = holder;
    },
    failChecks: () => {
      failCheck = true;
    },
    get checkFailures() {
      return checkFailures;
    },
  };
}

function listener(port: number): BoundListener {
  return { port, close: () => Promise.resolve() };
}

describe("[A2.3.8.http.port] the UI port", () => {
  test("first start: 7713 to 7733 in order; the first free port that passes the check is persisted", async () => {
    expect(PORT_RANGE[0]).toBe(7713);
    expect(PORT_RANGE.at(-1)).toBe(7733);
    expect(PORT_RANGE).toHaveLength(21);
    const m = machine({ 7713: "mine", 7714: "other" });
    const choice = await choosePort(undefined, m.facts);
    expect(choice).toMatchObject({ kind: "bound", persisted: 7715, first: true });
    expect(m.persisted).toEqual([7715]);
    // 7713 is this user's: skipped. 7714 is another user's: recorded and skipped.
    expect(m.records).toEqual([{ port: 7714, holders: [{ owner: "1002" }] }]);
    expect(m.log).toEqual([
      "check 7713",
      "listen 7713",
      "check 7713 after bind",
      "check 7714",
      "check 7715",
      "listen 7715",
    ]);
  });

  test("first start: a port with a recorded sighting is skipped; a full range takes an OS port, persisting nothing", async () => {
    const m = machine({}, { 7713: 1 });
    expect(await choosePort(undefined, m.facts, [7713, 7714])).toMatchObject({
      kind: "bound",
      persisted: 7714,
    });
    const full = machine({ 7713: "mine", 7714: "mine" });
    const choice = await choosePort(undefined, full.facts, [7713, 7714]);
    expect(choice).toMatchObject({ kind: "moved", persisted: undefined });
    expect(choice.kind === "moved" ? choice.listener.port : 0).toBe(41385);
    expect(full.persisted).toEqual([]);
  });

  test("the persisted port, free: bound, nothing written", async () => {
    const m = machine({});
    expect(await choosePort(7713, m.facts)).toMatchObject({
      kind: "bound",
      persisted: 7713,
      first: false,
    });
    expect(m.persisted).toEqual([]);
    expect(m.records).toEqual([]);
  });

  test("the persisted port held by this user's own process: a fallback for this run, machine.toml unchanged", async () => {
    const m = machine({ 7713: "mine" });
    const choice = await choosePort(7713, m.facts);
    expect(choice).toMatchObject({ kind: "moved", persisted: 7713 });
    expect(choice.kind === "moved" ? choice.listener.port : 0).toBe(41385);
    expect(m.persisted).toEqual([]);
    // The check ran before the bind and again after it failed.
    expect(m.log).toEqual(["check 7713", "listen 7713", "check 7713 after bind", "listen 0"]);
  });

  test("another user holds the persisted port: no fallback, no listener at all, and the sighting is recorded", async () => {
    const m = machine({ 7713: "other" });
    expect(await choosePort(7713, m.facts)).toEqual({ kind: "blocked", persisted: 7713 });
    expect(m.records).toEqual([{ port: 7713, holders: [{ owner: "1002" }] }]);
    expect(m.log.some((l) => l.startsWith("listen"))).toBe(false);
  });

  test("another user recently held it (recorded): blocked although the port is free now", async () => {
    const m = machine({}, { 7713: 1 });
    expect(await choosePort(7713, m.facts)).toEqual({ kind: "blocked", persisted: 7713 });
    expect(m.log).toEqual([]);
  });

  test("another user seen only after the bind failed (a connection, or a socket lsof could not see): blocked", async () => {
    const m = machine({ 7713: "mine" });
    // The bind fails; the second check sees another user.
    const facts: PortFacts = {
      ...m.facts,
      holders: (_port, { bindFailed }) => (bindFailed ? [{ owner: null }] : []),
    };
    expect(await choosePort(7713, facts)).toEqual({ kind: "blocked", persisted: 7713 });
    expect(m.records).toEqual([{ port: 7713, holders: [{ owner: null }] }]);
  });

  test("a check that cannot run is reported and treats the port as free", async () => {
    const m = machine({});
    m.failChecks();
    expect(await choosePort(7713, m.facts)).toMatchObject({ kind: "bound", persisted: 7713 });
    expect(m.checkFailures).toBe(1);
  });

  test("a sighting that cannot be written still blocks at once, and the failure is reported", async () => {
    const failed: string[] = [];
    const broken = (m: ReturnType<typeof machine>): PortFacts => ({
      ...m.facts,
      record: () => Promise.reject(new Error("disk full")),
      writeFailed: (stage) => failed.push(stage),
    });
    expect(await choosePort(7713, broken(machine({ 7713: "other" })))).toEqual({
      kind: "blocked",
      persisted: 7713,
    });
    const moved = machine({ 7713: "other" });
    expect(await retryPort(7713, broken(moved))).toEqual({ kind: "blocked" });
    // A first start skips the port as before.
    expect(
      await choosePort(undefined, broken(machine({ 7713: "other" })), [7713, 7714]),
    ).toMatchObject({ kind: "bound", persisted: 7714 });
    expect(failed).toEqual(["sighting", "sighting", "sighting"]);
  });

  test("a first start whose port cannot be written to machine.toml claims no persisted port", async () => {
    const failed: string[] = [];
    const m = machine({});
    const facts: PortFacts = {
      ...m.facts,
      persist: () => false,
      writeFailed: (stage) => failed.push(stage),
    };
    const choice = await choosePort(undefined, facts, [7713]);
    expect(choice).toMatchObject({ kind: "bound", persisted: undefined, first: true });
    expect(choice.kind === "bound" ? choice.listener.port : 0).toBe(7713);
    expect(failed).toEqual(["persist"]);
  });

  test("the retry while moved: kept while busy, back when free, blocked when another user appears", async () => {
    const m = machine({ 7713: "mine" });
    expect(await retryPort(7713, m.facts)).toEqual({ kind: "kept" });
    m.set(7713, "free");
    const back = await retryPort(7713, m.facts);
    expect(back.kind).toBe("moved_back");
    m.set(7713, "other");
    expect(await retryPort(7713, m.facts)).toEqual({ kind: "blocked" });
    expect(m.records.map((r) => r.port)).toEqual([7713]);
    // Once recorded, a retry stays blocked even when the port is free again.
    m.set(7713, "free");
    expect(await retryPort(7713, m.facts)).toEqual({ kind: "blocked" });
  });
});
