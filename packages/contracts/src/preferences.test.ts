// The preferences registry (A1 3.16, A3 3.8.2; A7 3.10 M3.11). The writer's side of `pref.set` is
// tested in packages/storage/test/preferences.test.ts, machine.toml's in the service.
import { describe, expect, test } from "vitest";
import { a1ErrorBody } from "./a1-errors.ts";
import {
  checkPreferences,
  EFFORT_ABOUT_MAX,
  EFFORT_KEY_MAX,
  EFFORT_LEVELS,
  EFFORT_NAME_MAX,
  effortNamesFit,
  effortTimeText,
  FEATURE_FLAGS,
  fitsShape,
  mayWrite,
  PREFERENCES,
  preferenceSpec,
  preferenceValue,
  readPreference,
  type PreferenceSpec,
  type ValueShape,
} from "./preferences.ts";

const spec = (key: string): PreferenceSpec => {
  const found = preferenceSpec(key);
  if (found === undefined) throw new Error(`no declaration of ${key}`);
  return found;
};

const stored = (value: unknown, schemaVer = 1) => ({ value: JSON.stringify(value), schemaVer });

describe("[A1.3.16.prefs.registry] every preference is declared once, with a shape, a default, a scope and its writers", () => {
  test("the registry keeps its own rules", () => {
    expect(checkPreferences()).toEqual([]);
  });

  test("each rule fires on a declaration that breaks it", () => {
    const base: PreferenceSpec = {
      key: "ui.sample",
      scope: "space",
      shape: { type: "boolean" },
      default: true,
      writers: ["human"],
      policy: false,
      schemaVer: 1,
      summary: "A sample",
    };
    const broken: [Partial<PreferenceSpec>, string][] = [
      [{ key: "Sample" }, "not a preference name"],
      [{ default: "yes" }, "the default does not fit"],
      [{ writers: ["agent"] }, "the human must be a writer"],
      [{ policy: true, writers: ["human", "agent"] }, "a policy key has the human"],
      [{ scope: "machine", writers: ["human", "agent"] }, "a machine preference"],
      [{ schemaVer: 0 }, "the schema version"],
      [{ key: "features.sample" }, "flags, and only flags"],
      [{ flag: { stability: "preview" } }, "flags, and only flags"],
      [
        {
          key: "features.sample",
          flag: { stability: "preview" },
          shape: { type: "integer", min: 0, max: 1 },
          default: 0,
        },
        "a flag is a boolean or an enum",
      ],
      [{ key: "features.sample", flag: { stability: "preview" }, policy: true }, "a flag has"],
      [{ summary: "two\nlines" }, "the summary"],
    ];
    expect(checkPreferences([base])).toEqual([]);
    for (const [change, problem] of broken) {
      const problems = checkPreferences([{ ...base, ...change }]);
      expect(problems.join(" | "), problem).toContain(problem);
    }
    expect(checkPreferences([base, base])).toEqual(["ui.sample: declared twice"]);
    expect(checkPreferences([base], ["ui.sample"])).toEqual(["ui.sample: a retired name"]);
  });

  test("A1 3.16's keys and A3 3.8.2's policy keys are declared as the plan names them", () => {
    const table = PREFERENCES.map((p) => [p.key, p.scope, p.policy, p.writers.join("+")]);
    expect(table).toEqual([
      ["ui.theme", "machine", false, "human"],
      ["ui.single_keys", "machine", false, "human"],
      ["tasks.statuses", "space", false, "human+agent"],
      ["tasks.effort_scale", "space", false, "human"],
      ["tasks.dedupe_window_days", "space", false, "human"],
      ["grouping.names", "space", false, "human"],
      ["autonomy.level", "space", true, "human"],
      ["autonomy.agent_tasks_to_inbox", "space", true, "human"],
      ["autonomy.overrides", "space", true, "human"],
      ["autonomy.areas", "space", true, "human"],
      ["targets.default", "space", true, "human"],
      ["projection.enabled", "space", false, "human"],
      ["projection.dir", "machine", false, "human"],
      ["features.search_trigram", "space", false, "human"],
    ]);
    expect(spec("ui.theme").default).toBe("sumi");
    expect(spec("tasks.dedupe_window_days").default).toBe(30);
    expect(spec("projection.enabled").default).toBe(true);
    expect(spec("autonomy.level").default).toBe("review");
    expect(spec("targets.default").default).toBeNull();
    expect(preferenceSpec("ui.nothing")).toBeUndefined();
    expect(preferenceSpec("constructor")).toBeUndefined();
  });

  test("policy keys refuse agent writers; an agent writes only keys that list it", () => {
    for (const p of PREFERENCES) {
      expect(mayWrite(p, "human"), p.key).toBe(true);
      expect(mayWrite(p, "agent"), p.key).toBe(p.writers.includes("agent"));
      expect(mayWrite(p, "routine"), p.key).toBe(p.writers.includes("agent"));
      for (const kind of ["system", "import", "other"]) expect(mayWrite(p, kind)).toBe(false);
      if (p.policy) expect(mayWrite(p, "agent"), p.key).toBe(false);
    }
    // The writer's refusal reaches a caller as forbidden with rule policy (A3 3.4.11, 3.8.3).
    expect(a1ErrorBody("PREFERENCE_FORBIDDEN", "Only the user changes this preference")).toEqual({
      code: "forbidden",
      message: "Only the user changes this preference",
      data: { cause: "PREFERENCE_FORBIDDEN", rule: "policy" },
    });
  });

  test("a shape takes what it declares and nothing else", () => {
    const cases: [ValueShape, unknown[], unknown[]][] = [
      [{ type: "enum", values: ["a", "b"] }, ["a", "b"], ["c", 1, null, ["a"]]],
      [{ type: "boolean" }, [true, false], [0, "true", null]],
      [{ type: "integer", min: 0, max: 3 }, [0, 3], [-1, 4, 1.5, "1", Number.NaN]],
      [
        { type: "text", max: 3, pattern: /^[a-z]+$/ },
        ["abc"],
        ["abcd", "ABC", "", " ", "a\nb", "a\u202eb", "e\u0301"],
      ],
      [{ type: "path" }, ["/home/x", "C:\\x", "D:/x", "\\\\server\\share"], ["x", "./x", "/a\nb"]],
      [
        { type: "list", item: { type: "boolean" }, min: 1, max: 2, unique: "self" },
        [[true], [true, false]],
        [[], [true, true], [true, false, true], ["x"], {}],
      ],
      [
        {
          type: "list",
          item: { type: "object", fields: { key: { type: "text", max: 5 } } },
          min: 1,
          max: 3,
          unique: "key",
        },
        [[{ key: "S" }, { key: "M" }]],
        [[{ key: "S" }, { key: "S" }], [{ key: "S", extra: 1 }], [{}], ["S"]],
      ],
      [
        { type: "object", fields: { a: { type: "boolean" } } },
        [{ a: true }],
        [{}, { a: 1 }, { a: true, b: true }, [true], null],
      ],
      [
        { type: "map", key: /^[a-z]+$/, value: { type: "boolean" }, max: 1 },
        [{}, { a: true }],
        [{ a: true, b: false }, { A: true }, { a: "yes" }, [], null],
      ],
    ];
    for (const [shape, good, bad] of cases) {
      for (const value of good) expect(fitsShape(shape, value), JSON.stringify(value)).toBe(true);
      for (const value of bad) expect(fitsShape(shape, value), JSON.stringify(value)).toBe(false);
    }
    // An object made by a class is not plain data.
    class Thing {
      a = true;
    }
    expect(fitsShape({ type: "object", fields: { a: { type: "boolean" } } }, new Thing())).toBe(
      false,
    );
  });

  test("a reader takes the stored value when it fits, else the default, and never a newer build's", () => {
    const theme = spec("ui.theme");
    expect(preferenceValue(theme, undefined)).toEqual({
      key: "ui.theme",
      value: "sumi",
      state: "default",
    });
    expect(preferenceValue(theme, stored("washi"))).toMatchObject({ value: "washi", state: "set" });
    // null resets the key: the row stays, with null, and the default applies.
    expect(preferenceValue(theme, stored(null))).toMatchObject({ value: "sumi", state: "default" });
    expect(preferenceValue(theme, stored("purple"))).toMatchObject({
      value: "sumi",
      state: "invalid",
    });
    expect(preferenceValue(theme, { value: "{not json", schemaVer: 1 })).toMatchObject({
      value: "sumi",
      state: "invalid",
    });
    expect(preferenceValue(theme, stored("washi", 2))).toMatchObject({
      value: "sumi",
      state: "newer",
    });
    expect(readPreference("tasks.dedupe_window_days", stored(5)).value).toBe(5);
    expect(readPreference("tasks.dedupe_window_days", stored(3_651)).value).toBe(30);
    expect(() => readPreference("ui.nothing", undefined)).toThrow();
  });
});

describe("[A1.3.16.prefs.flags] each feature flag has a default and is read through the registry", () => {
  test("there is at least one flag, and each one is a space key under features.", () => {
    expect(FEATURE_FLAGS.map((f) => f.key)).toContain("features.search_trigram");
    for (const f of FEATURE_FLAGS) {
      expect(f.key.startsWith("features."), f.key).toBe(true);
      expect(f.scope).toBe("space");
      expect(f.policy).toBe(false);
    }
  });

  test.each(FEATURE_FLAGS.map((f) => [f.key, f] as const))(
    "%s reads its default unset, its value set, and its default again after a reset",
    (_key, f) => {
      expect(f.default).not.toBeNull();
      expect(preferenceValue(f, undefined).value).toBe(f.default);
      const other =
        f.shape.type === "boolean"
          ? !(f.default as boolean)
          : f.shape.type === "enum"
            ? f.shape.values.find((v) => v !== f.default)
            : undefined;
      expect(other).toBeDefined();
      expect(preferenceValue(f, stored(other)).value).toBe(other);
      expect(preferenceValue(f, stored(null)).value).toBe(f.default);
      expect(preferenceValue(f, stored("not a flag value")).value).toBe(f.default);
    },
  );

  test("features.search_trigram is off by default, as a preview", () => {
    const f = spec("features.search_trigram");
    expect(f.default).toBe(false);
    expect(f.flag).toEqual({ stability: "preview" });
  });
});

/**
 * The reader of the build before version 2 (step 1's `effortKeys` and declaration), kept as it
 * shipped: what that build shows for a space this one wrote.
 */
function stepOneNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return undefined;
  const keys: string[] = [];
  for (const item of value) {
    const key: unknown =
      typeof item === "object" && item !== null ? (item as { key?: unknown }).key : undefined;
    const line =
      typeof key === "string" &&
      key.trim() !== "" &&
      key.normalize("NFC") === key &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(key) &&
      Array.from(key).length <= 20;
    if (!line || key.trim() !== key) return undefined;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

describe("[A1.3.16.prefs.effort-levels] an effort level is a name, a typical time and a line on what belongs on it", () => {
  const scale = spec("tasks.effort_scale");
  const fits = (levels: unknown) => fitsShape(scale.shape, levels);

  test("a level takes a name with single spaces inside, a time of 1 to 999 of a unit, a line of up to 280", () => {
    expect(scale.default).toEqual(EFFORT_LEVELS);
    expect(EFFORT_LEVELS.map((level) => level.key)).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(
      fits([
        { key: "Half a day", time: { amount: 4, unit: "hours" }, about: "One sitting" },
        { key: "2h" },
        { key: "W", time: { amount: 999, unit: "weeks" } },
        { key: "Long", about: "x".repeat(EFFORT_ABOUT_MAX) },
      ]),
    ).toBe(true);
    for (const wrong of [
      [{ key: "Half  a day" }],
      [{ key: " Day" }],
      [{ key: "Day " }],
      [{ key: "null" }],
      [{ key: "Day", time: { amount: 0, unit: "hours" } }],
      [{ key: "Day", time: { amount: 1000, unit: "hours" } }],
      [{ key: "Day", time: { amount: 1.5, unit: "hours" } }],
      [{ key: "Day", time: { amount: 2, unit: "fortnights" } }],
      [{ key: "Day", time: { amount: 2 } }],
      [{ key: "Day", about: "x".repeat(EFFORT_ABOUT_MAX + 1) }],
      [{ key: "Day", about: "Two\nlines" }],
      [{ key: "Day", colour: "teal" }],
      [{ key: "Day" }, { key: "day" }],
    ]) {
      expect(fits(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  test("a name set anew has at most 10 characters; a longer one the space holds may stay", () => {
    expect(EFFORT_NAME_MAX).toBe("Half a day".length);
    expect(effortNamesFit(["Half a day"], [])).toBe(true);
    expect(effortNamesFit(["Half a day!"], [])).toBe(false);
    const held = "Deep-work_2.0".padEnd(EFFORT_KEY_MAX, "x");
    expect(effortNamesFit(["S", held], ["S", held])).toBe(true);
    expect(effortNamesFit(["S", held.slice(0, -1)], ["S", held])).toBe(false);
  });

  test("a list of names an earlier build stored: a default level's name means that level, another stays a name", () => {
    const read = preferenceValue(scale, stored([{ key: "XS" }, { key: "Q" }, { key: "XL" }], 1));
    expect(read).toEqual({
      key: "tasks.effort_scale",
      value: [EFFORT_LEVELS[0], { key: "Q" }, EFFORT_LEVELS[4]],
      state: "set",
    });
    // The same names written by this build mean only what they say.
    expect(preferenceValue(scale, stored([{ key: "XS" }], 2)).value).toEqual([{ key: "XS" }]);
  });

  test("a newer build's list gives its names, and each time and line this build can read", () => {
    const read = preferenceValue(
      scale,
      stored(
        [
          { key: "XS", time: { amount: 10, unit: "minutes" }, colour: "teal" },
          { key: "S", time: { amount: 1, unit: "fortnights" }, about: "Short" },
        ],
        3,
      ),
    );
    expect(read).toEqual({
      key: "tasks.effort_scale",
      value: [
        { key: "XS", time: { amount: 10, unit: "minutes" } },
        { key: "S", about: "Short" },
      ],
      state: "newer",
    });
  });

  test("the build before this one reads the names of a list this build writes", () => {
    const before: PreferenceSpec = {
      ...scale,
      schemaVer: 1,
      default: [{ key: "S" }, { key: "M" }, { key: "L" }],
      salvage: (value) => stepOneNames(value)?.map((key) => ({ key })),
    };
    delete (before as { upgrade?: unknown }).upgrade;
    const written = [...EFFORT_LEVELS, { key: "Half a day", about: "One sitting" }];
    expect(fits(written)).toBe(true);
    expect(preferenceValue(before, stored(written, scale.schemaVer))).toEqual({
      key: "tasks.effort_scale",
      value: [...EFFORT_LEVELS.map(({ key }) => ({ key })), { key: "Half a day" }],
      state: "newer",
    });
  });

  test("a level's time in words", () => {
    expect(effortTimeText({ amount: 1, unit: "hours" })).toBe("1 hour");
    expect(effortTimeText({ amount: 10, unit: "minutes" })).toBe("10 minutes");
    expect(effortTimeText({ amount: 1, unit: "weeks" })).toBe("1 week");
  });
});
