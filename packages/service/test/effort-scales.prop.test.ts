// Any list of sizes the person sets works through the real path: generated lists of 1 to 10 names
// (one character, the longest, a digit first, `.`, `-` and `_`, a space inside, mixed case) are set
// as the person, every size is given to a task through an agent's add_tasks, one is changed with
// update_task, and search, its order, the tools' text, the readable file and the refusal of a wrong
// size all follow the list. Fixture text only.
import fc from "fast-check";
import { EFFORT_NAME_MAX, EFFORT_SCALE_MAX } from "@ttasks/contracts";
import { afterAll, describe, expect, test } from "vitest";
import { effortSpaces, type Json } from "./effort-world.ts";

const spaces = effortSpaces("effort-lists");
afterAll(spaces.cleanup);

const FIRST = "A-Za-z0-9";
const REST = `${FIRST}_.-`;
/** A size name as the scale takes it, with the edges drawn often. */
const name = fc.oneof(
  fc.stringMatching(new RegExp(`^[${FIRST}]$`, "u")),
  fc.stringMatching(new RegExp(`^[${FIRST}][${REST}]{${String(EFFORT_NAME_MAX - 1)}}$`, "u")),
  fc.stringMatching(new RegExp(`^[0-9][${REST}]{0,${String(EFFORT_NAME_MAX - 1)}}$`, "u")),
  fc.stringMatching(new RegExp(`^[${FIRST}][${REST}]{0,${String(EFFORT_NAME_MAX - 1)}}$`, "u")),
  fc.stringMatching(new RegExp(`^[${FIRST}][${REST}]{0,3} [${REST}]{1,4}$`, "u")),
  fc.constantFrom("a", "Z", "9", "2h", "1.5", "v1.2-rc_3", "Deep-work", "XS", "xl", "Half a day"),
);
const lists = fc.uniqueArray(name, {
  minLength: 1,
  maxLength: EFFORT_SCALE_MAX,
  selector: (n) => n.toLowerCase(),
});

/** The value of the `effort:` line of a readable file's front matter, as YAML reads it. */
function fileEffort(file: string): string | undefined {
  const line = file.split("\n").find((l) => l.startsWith("effort: "));
  const raw = line?.slice("effort: ".length);
  if (raw === undefined || raw === "") return undefined;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

describe("[A1.3.16.prefs.effort-lists] any list of sizes works through the real path", () => {
  test("search, sort, the tools' text, the readable file and a wrong size's refusal follow the list", async () => {
    await fc.assert(
      fc.asyncProperty(lists, async (names) => {
        const w = await spaces.next();
        await w.setScale(names);
        const drafts = [
          ...names.map((effort, i) => ({ title: `Fixture size ${String(i)}`, effort })),
          { title: "Fixture unsized" },
        ];
        expect(await w.tool("add_tasks", { tasks: drafts, request_id: w.rid() })).not.toMatch(
          /^error/u,
        );
        const all = async (q: string) => (await w.call("task.search", { q }))["rows"] as Json[];
        const rows = await all("sort:effort");
        const refOf = (title: string) => String(rows.find((r) => r["title"] === title)?.["ref"]);
        const sized = new Map<string, string | undefined>(
          drafts.map((d) => [refOf(d.title), "effort" in d ? d.effort : undefined]),
        );

        // One size changes to the largest through update_task.
        const last = names.at(-1) ?? "";
        const changed = refOf("Fixture size 0");
        expect(
          await w.tool("update_task", {
            task: changed,
            set: { effort: last },
            base: await w.base(),
            request_id: w.rid(),
          }),
        ).not.toMatch(/^error/u);
        sized.set(changed, last);

        for (const size of names) {
          const want = [...sized].filter(([, e]) => e === size).map(([ref]) => ref);
          const query = `effort:"${size}"`;
          const found = await all(query);
          expect(found.map((r) => r["ref"]).sort(), size).toEqual([...want].sort());
          const text = await w.tool("search", { q: query });
          for (const ref of want) expect(text).toContain(`${ref} · open · P4 · ${size} · `);
        }

        const rank = (r: Json) => {
          const at = names.indexOf(String(r["effort"]));
          return r["effort"] === undefined ? Infinity : at;
        };
        const up = (await all("sort:effort")).map(rank);
        expect(up).toEqual([...up].sort((a, b) => a - b));
        const down = (await all("sort:-effort")).map(rank);
        const largestFirst = (a: number, b: number) =>
          a === Infinity || b === Infinity
            ? Number(a === Infinity) - Number(b === Infinity)
            : b - a;
        expect(down).toEqual([...down].sort(largestFirst));
        expect(up).not.toContain(-1);

        for (const [ref, effort] of sized) {
          const got = await w.tool("get_task", { task: ref });
          if (effort === undefined) expect(got).not.toContain("Effort:");
          else expect(got).toContain(`Effort: ${effort}`);
          expect(fileEffort(w.file(ref)), ref).toBe(effort);
        }

        const wrong = ["NoSuchSize", "No-such-size-2"].find((n) => !names.includes(n)) ?? "";
        const refused = await w.refusal("task.add", {
          tasks: [{ title: "Fixture wrong size", effort: wrong }],
          request_id: w.rid(),
        });
        expect(refused.hint).toBe(
          `Use one of the space's efforts: ${names.join(", ")}. Put another estimate in context.`,
        );
      }),
      { numRuns: 25 },
    );
  }, 600_000);
});
