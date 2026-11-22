// What a ticket and a preset name together (named.ts), over stand-ins for the shim's host and the
// runs: each source is tested with its own records (packages/launch's shim-named.test.ts, and the
// run tests through a real run).
import { describe, expect, test } from "vitest";
import type { LiveLaunch } from "@ttasks/launch";
import type { LiveRun } from "../runs/service.ts";
import { namedBy, type NamedSources } from "./named.ts";

const SPACE = "sp_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const PRESET = "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a1f";
const ONE: LiveLaunch = {
  launch: "la_00000000000000000000000001",
  space: SPACE,
  task: "t_0k3m5n7p9q1r3s5t7v9w1x3y5z",
  session: "se_00000000000000000000000001",
  app: "claude-code",
  home: "/home/fixture/.claude",
};
const TWO: LiveLaunch = {
  ...ONE,
  launch: "la_00000000000000000000000002",
  session: "se_00000000000000000000000002",
};
const RUN: LiveRun = {
  run: "ru_00000000000000000000000003",
  space: SPACE,
  task: null,
  instance: "fixture-runner",
  session: "se_00000000000000000000000003",
};

/** Sources where each ticket and preset names what `tickets` and `presets` say. */
function sources(
  tickets: Record<string, LiveLaunch>,
  presets: Record<string, LiveLaunch>,
  runs: Record<string, LiveRun> = {},
  launching = true,
): NamedSources {
  return {
    launches: () =>
      launching
        ? {
            liveByTicket: (ticket) => tickets[ticket],
            liveByPreset: (preset) => presets[preset],
          }
        : undefined,
    runs: { liveByTicket: (ticket) => runs[ticket] },
  };
}

describe("[A3.3.7.binding.named] what an environment's ticket and preset name together", () => {
  test("a launch's ticket or preset names that launch; both of one launch name it once", () => {
    const s = sources({ T1: ONE }, { [PRESET]: ONE });
    const one = { kind: "one", live: { of: "launch", ...ONE } };
    expect(namedBy(s, { ticket: "T1" })).toEqual(one);
    expect(namedBy(s, { preset: PRESET })).toEqual(one);
    expect(namedBy(s, { ticket: "T1", preset: PRESET })).toEqual(one);
  });

  test("a run's ticket names the run", () => {
    const s = sources({}, {}, { R1: RUN });
    expect(namedBy(s, { ticket: "R1" })).toEqual({ kind: "one", live: { of: "run", ...RUN } });
  });

  test("a ticket and a preset of two launches, or of a run and a launch, give both", () => {
    expect(
      namedBy(sources({ T2: TWO }, { [PRESET]: ONE }), { ticket: "T2", preset: PRESET }),
    ).toEqual({
      kind: "two",
      ticket: { of: "launch", ...TWO },
      preset: { of: "launch", ...ONE },
    });
    expect(
      namedBy(sources({}, { [PRESET]: ONE }, { R1: RUN }), { ticket: "R1", preset: PRESET }),
    ).toMatchObject({ kind: "two", ticket: { of: "run" }, preset: { of: "launch" } });
  });

  test("a value that names nothing leaves the other's; neither names anything: none", () => {
    const s = sources({ T1: ONE }, { [PRESET]: ONE });
    expect(namedBy(s, { ticket: "unknown", preset: PRESET })).toMatchObject({
      kind: "one",
      live: { launch: ONE.launch },
    });
    expect(
      namedBy(s, { ticket: "T1", preset: "6f1c2a4e-9b3d-4c7e-8a5f-0d2e4b6c8a10" }),
    ).toMatchObject({ kind: "one", live: { launch: ONE.launch } });
    expect(namedBy(s, {})).toEqual({ kind: "none" });
    expect(namedBy(s, { ticket: "unknown" })).toEqual({ kind: "none" });
  });

  test("before launching started, a run's ticket still names its run and a preset nothing", () => {
    const s = sources({ T1: ONE }, { [PRESET]: ONE }, { R1: RUN }, false);
    expect(namedBy(s, { ticket: "R1" })).toMatchObject({ kind: "one", live: { of: "run" } });
    expect(namedBy(s, { ticket: "T1", preset: PRESET })).toEqual({ kind: "none" });
  });
});
