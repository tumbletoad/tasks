// Approval of definitions that arrive with data (A4 3.2, A4 5.1 "Approval hashes"): the canonical
// form is stable under key order, and changing any one byte of an approved definition disables it.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  approvalHash,
  approvalState,
  canonicalJson,
  NotCanonical,
  routineApproval,
} from "./approval.ts";
import { APPROVAL_KEY, type Verdict } from "./sections.ts";

/** A custom target as a space would carry it (A4 3.4.7), fixture text only. */
const CURSOR_AGENT = {
  id: "custom:cursor-agent",
  label: "Cursor Agent",
  glyph: "Cu",
  route: { kind: "terminal", folder: "cwd", prompt: "sent", nativeId: "none", budget: 4000 },
  argv: ["{exec}", "--workspace", "{cwd}", "{extra_args}", "--", "{brief}"],
  space_id: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf",
  updated_at: "2026-11-13T08:00:00.000Z",
};

const allowed = (definition: unknown): ReadonlyMap<string, Verdict> =>
  new Map([[approvalHash("custom_target", definition), "allow" as const]]);

/** Every string leaf of `value`, with a setter that replaces it in a deep copy. */
function stringLeaves(value: unknown): { path: (string | number)[]; text: string }[] {
  const out: { path: (string | number)[]; text: string }[] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (typeof v === "string") out.push({ path, text: v });
    else if (Array.isArray(v)) {
      for (const [i, item] of (v as unknown[]).entries()) walk(item, [...path, i]);
    } else if (typeof v === "object" && v !== null) {
      for (const [k, item] of Object.entries(v)) walk(item, [...path, k]);
    }
  };
  walk(value, []);
  return out;
}

/** A copy of the value without the keys given. */
function without(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

function replaced(value: unknown, path: (string | number)[], text: string): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1);
  if (last !== undefined) at[last] = text;
  return copy;
}

describe("[A4.3.2.approval.hash] approval hashes of definitions that arrive with data", () => {
  test("the hash is a sha256 key, stable under key order, and ignores only reference keys", () => {
    const hash = approvalHash("custom_target", CURSOR_AGENT);
    expect(hash).toMatch(APPROVAL_KEY);
    const reordered = Object.fromEntries(Object.entries(CURSOR_AGENT).reverse());
    expect(approvalHash("custom_target", reordered)).toBe(hash);
    // Reference-only keys are storage bookkeeping: a new revision of the record is no new content.
    const content = without(CURSOR_AGENT, ["space_id", "updated_at"]);
    expect(approvalHash("custom_target", { ...content, seq: 9, created_at: "x" })).toBe(hash);
    // The kind is part of the input: the same JSON as a routine never matches.
    expect(approvalHash("routine", CURSOR_AGENT)).not.toBe(hash);
    // The golden value pins the canonical form and the domain line. Computed independently with
    // printf 'tasks-approval/1\ncustom_target\n<canonical JSON>' | sha256sum.
    expect(hash).toBe("sha256-5a2c6fc40086e5b31b295eae1f864a54a65f488e891a6a5d55fd919d92bd989a");
  });

  test("canonical JSON is RFC 8785 for plain data and refuses what JSON cannot carry exactly", () => {
    expect(canonicalJson({ b: [1, "x", null, true], a: { d: -0, c: 1e21 } })).toBe(
      '{"a":{"c":1e+21,"d":0},"b":[1,"x",null,true]}',
    );
    // Keys sort by UTF-16 code units: "é" (U+00E9) before "😀" (D83D …) before "ｚ" (U+FF5A).
    expect(canonicalJson({ ｚ: 1, "😀": 2, é: 3 })).toBe('{"é":3,"😀":2,"ｚ":1}');
    for (const bad of [Number.NaN, Infinity, undefined, 1n, new Date(0), () => 1, new Map()]) {
      expect(() => canonicalJson({ v: bad })).toThrow(NotCanonical);
    }
    expect(approvalState("custom_target", { v: Number.NaN }, new Map())).toBe("needs_approval");
  });

  test("no value outside plain JSON shares a form with one: holes, a non-plain definition, text UTF-8 cannot carry", () => {
    // A hole is no element: [,] must not read as [].
    // eslint-disable-next-line no-sparse-arrays
    const holes = [[,], new Array<unknown>(1), [1, , 2]];
    for (const bad of holes) expect(() => canonicalJson({ argv: bad })).toThrow(NotCanonical);
    // The definition itself is checked before its reference keys are removed.
    for (const bad of [new Date(0), new Map([["a", 1]]), Object.assign(new Date(0), { a: 1 })]) {
      expect(() => approvalHash("custom_target", bad)).toThrow(NotCanonical);
      expect(approvalState("custom_target", bad, allowed({}))).toBe("needs_approval");
    }
    // RFC 8785 refuses a lone surrogate, in a value or a key.
    const lone = String.fromCharCode(0xdc00);
    for (const bad of [{ v: `a${lone}` }, { [`k${lone}`]: 1 }, { v: [lone] }]) {
      expect(() => canonicalJson(bad)).toThrow(NotCanonical);
    }
    // A well-formed pair is fine.
    expect(canonicalJson({ v: "😀" })).toBe('{"v":"😀"}');
  });

  test("changing any one byte of any string of an approved definition disables it", () => {
    const approvals = allowed(CURSOR_AGENT);
    expect(approvalState("custom_target", CURSOR_AGENT, approvals)).toBe("approved");
    let checked = 0;
    for (const { path, text } of stringLeaves(CURSOR_AGENT)) {
      if (path[0] === "space_id" || path[0] === "updated_at") continue;
      const bytes = Buffer.from(text, "utf8");
      for (let i = 0; i < bytes.length; i += 1) {
        for (const delta of [1, 0x20, 0x80]) {
          const changed = Buffer.from(bytes);
          changed[i] = ((changed[i] ?? 0) + delta) & 0xff;
          // A byte change that is not valid UTF-8 cannot reach a parsed definition at all.
          let mutated: string;
          try {
            mutated = new TextDecoder("utf-8", { fatal: true }).decode(changed);
          } catch {
            continue;
          }
          if (mutated === text) continue;
          const state = approvalState(
            "custom_target",
            replaced(CURSOR_AGENT, path, mutated),
            approvals,
          );
          expect(state, `${path.join(".")} byte ${String(i)}`).toBe("needs_approval");
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    // Number and boolean leaves, an added key and a removed one change the content too.
    const route = { ...CURSOR_AGENT.route, budget: 4001 };
    expect(approvalState("custom_target", { ...CURSOR_AGENT, route }, approvals)).toBe(
      "needs_approval",
    );
    expect(approvalState("custom_target", { ...CURSOR_AGENT, allow_shell: true }, approvals)).toBe(
      "needs_approval",
    );
    expect(approvalState("custom_target", without(CURSOR_AGENT, ["glyph"]), approvals)).toBe(
      "needs_approval",
    );
    // No Unicode normalisation: the decomposed form of a composed character is another definition.
    const composed = { ...CURSOR_AGENT, label: `Caf${String.fromCodePoint(0xe9)}` };
    const decomposed = { ...CURSOR_AGENT, label: `Cafe${String.fromCodePoint(0x301)}` };
    expect(approvalState("custom_target", decomposed, allowed(composed))).toBe("needs_approval");
  });

  test("a deny is remembered for the same content only; an approval of other content approves nothing", () => {
    const deny = new Map([[approvalHash("custom_target", CURSOR_AGENT), "deny" as const]]);
    expect(approvalState("custom_target", CURSOR_AGENT, deny)).toBe("denied");
    const other = { ...CURSOR_AGENT, argv: ["{exec}", "--", "{brief}"] };
    expect(approvalState("custom_target", other, deny)).toBe("needs_approval");
    expect(approvalState("custom_target", CURSOR_AGENT, new Map())).toBe("needs_approval");
  });

  test("a routine's approval covers its template, params, instance and that instance's run permission", () => {
    const routine = {
      template: "Refresh {{sources}}",
      params: { sources: "mail" },
      instance_id: "codex-work",
    };
    const approved = routineApproval(routine, "auto-edit");
    const approvals = new Map([[approvalHash("routine", approved), "allow" as const]]);
    expect(approvalState("routine", routineApproval(routine, "auto-edit"), approvals)).toBe(
      "approved",
    );
    // A raised permission asks again (A4 3.12.1).
    expect(approvalState("routine", routineApproval(routine, "full-access"), approvals)).toBe(
      "needs_approval",
    );
    expect(
      approvalState(
        "routine",
        routineApproval({ ...routine, instance_id: "codex-personal" }, "auto-edit"),
        approvals,
      ),
    ).toBe("needs_approval");
  });

  test("property: random definitions hash the same under any key order and differently after any leaf change", () => {
    const definition = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.oneof(
        fc.string({ maxLength: 12 }),
        fc.integer(),
        fc.boolean(),
        fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 }),
      ),
      { minKeys: 1, maxKeys: 6 },
    );
    fc.assert(
      fc.property(definition, fc.string({ minLength: 1, maxLength: 3 }), (def, extra) => {
        const keys = Object.keys(def).filter(
          (k) => !["space_id", "created_at", "updated_at", "seq", "rev", "__proto__"].includes(k),
        );
        fc.pre(keys.length > 0);
        const clean = Object.fromEntries(keys.map((k) => [k, def[k]]));
        const approvals = allowed(clean);
        const reversed = Object.fromEntries(Object.entries(clean).reverse());
        expect(approvalState("custom_target", reversed, approvals)).toBe("approved");
        const key = keys[0] ?? "";
        const value = clean[key];
        const changed =
          typeof value === "string"
            ? value + extra
            : typeof value === "number"
              ? value + 1
              : typeof value === "boolean"
                ? !value
                : [...(value as string[]), extra];
        expect(approvalState("custom_target", { ...clean, [key]: changed }, approvals)).toBe(
          "needs_approval",
        );
      }),
      { numRuns: 300 },
    );
  });
});
