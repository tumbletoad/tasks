// Areas and projects by name, and possible duplicates by title (A3 3.4.5): the pure rules.
import { AppError } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { editDistance, resolveGroup } from "./groups.ts";
import type { GroupNames } from "./read.ts";
import { duplicateWarning, similarTitles } from "./similar.ts";

const names: GroupNames = {
  areas: [
    { id: "a_1", slug: "client-work", title: "Client work", area: null },
    { id: "a_2", slug: "home", title: "Home", area: null },
    { id: "a_3", slug: "qa", title: "QA", area: null },
  ],
  projects: [
    { id: "p_1", slug: "portal", title: "Portal", area: "a_1" },
    { id: "p_2", slug: "portal-2", title: "Portal", area: "a_2" },
  ],
  aliases: [{ alias: "old-home", kind: "area", id: "a_2" }],
};

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[A3.3.4.add.names] names, typos and similar titles", () => {
  test("a name matches by ID, slug, name ignoring case and spaces, or an old slug", () => {
    for (const name of ["a_1", "client-work", "CLIENT  WORK", "Client work"]) {
      expect(resolveGroup(names, "area", name, "p")).toBe("a_1");
    }
    expect(resolveGroup(names, "area", "old-home", "p")).toBe("a_2");
    // Two projects of one name: the area named beside it decides, else it is ambiguous.
    expect(resolveGroup(names, "project", "Portal", "p", { area: "a_1" })).toBe("p_1");
    expect(resolveGroup(names, "project", "Portal", "p", { area: "a_2" })).toBe("p_2");
    expect(resolveGroup(names, "project", "portal-2", "p")).toBe("p_2");
    expect(failure(() => resolveGroup(names, "project", "Portal", "p")).code).toBe("ambiguous");
  });

  test("a project named beside an area must be that area's: one only elsewhere is refused", () => {
    // The writer would file the task under the project's own area, not the one named.
    const refused = failure(() =>
      resolveGroup(names, "project", "portal-2", "tasks.0.project", { area: "a_1" }),
    );
    expect(refused).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.project" }], suggestions: ["Home"] },
    });
    expect(`${refused.message} ${refused.hint ?? ""}`).not.toContain("Home");
    // Neither area holds one: the areas of both matches are suggested.
    expect(
      failure(() => resolveGroup(names, "project", "Portal", "p", { area: "a_3" })).data,
    ).toMatchObject({ suggestions: ["Client work", "Home"] });
    // Without an area, the project decides where the task goes.
    expect(resolveGroup(names, "project", "portal-2", "p")).toBe("p_2");
  });

  test("a typo is within 2 edits and under half the name's length; anything else is new", () => {
    const typo = failure(() => resolveGroup(names, "area", "Client wrok", "tasks.0.area"));
    expect(typo.code).toBe("invalid_input");
    expect(typo.data).toMatchObject({ suggestions: ["Client work"] });
    expect(failure(() => resolveGroup(names, "area", "Hme", "p")).data).toMatchObject({
      suggestions: ["Home"],
    });
    // Two letters from "QA" is a new name, not a typo of it: the caller creates it.
    expect(resolveGroup(names, "area", "UX", "p")).toBeUndefined();
    expect(resolveGroup(names, "area", "Garden", "p")).toBeUndefined();
    // A lookup of an unknown name is not_found, with any close name.
    const lookup = failure(() => resolveGroup(names, "area", "Hme", "path", { lookup: true }));
    expect(lookup).toMatchObject({ code: "not_found", data: { suggestions: ["Home"] } });
    expect(editDistance("kitten", "sitting", 5)).toBe(3);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });

  test("a task filed by name lands where it did before lists came in pages", () => {
    // Areas as [title, slug], the name an agent files under, and the answer: the area's ID, a new
    // area, or a refusal with the close names. Each answer is what the resolver of the release
    // before gave for the same input.
    const home: [string, string][] = [["Home", "home"]];
    const resumes: [string, string][] = [
      ["Resume", "resume"],
      ["Résumé", "resume-2"],
    ];
    const work: [string, string][] = [["Client work", "client-work"]];
    const cafe: [string, string][] = [["Café", "cafe"]];
    const typo = (...suggestions: string[]) => ({ code: "invalid_input", suggestions });
    const table: [[string, string][], string, unknown][] = [
      [home, "Hoem", "new"],
      [home, "Hmoe", "new"],
      [home, "HOME", "a_1"],
      [resumes, "resume", "a_1"],
      [resumes, "résumé", "a_2"],
      [resumes, "Resume", "a_1"],
      [resumes, "Résumé", "a_2"],
      [resumes, "RÉSUMÉ", "a_2"],
      [[["Résumé", "resume"]], "Resume", "a_1"],
      [[["Resume", "resume"]], "Résumé", typo("Resume")],
      [[["Dev", "dev"]], "Dew", typo("Dev")],
      [[["2025", "2025"]], "2026", typo("2025")],
      [[["Q1", "q1"]], "Q2", "new"],
      [work, "Client   work", "a_1"],
      [work, "  client WORK ", "a_1"],
      [work, "Client wrok", typo("Client work")],
      [cafe, "Cafe", "a_1"],
      [cafe, "CAFÉ", "a_1"],
      [[["Projects", "projects"]], "Projcts", typo("Projects")],
      [[["Projects", "projects"]], "Porjects", typo("Projects")],
      [[["QA", "qa"]], "UX", "new"],
    ];
    for (const [areas, name, expected] of table) {
      const groups: GroupNames = {
        areas: areas.map(([title, slug], k) => ({
          id: `a_${String(k + 1)}`,
          slug,
          title,
          area: null,
        })),
        projects: [],
        aliases: [],
      };
      let answer: unknown;
      try {
        answer = resolveGroup(groups, "area", name, "p") ?? "new";
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        answer = { code: error.code, suggestions: error.data?.["suggestions"] };
      }
      expect(answer, `${name} beside ${areas.map(([title]) => title).join(", ")}`).toEqual(
        expected,
      );
    }
  });

  test("of several groups a name matches, the one named exactly wins, then a live one", () => {
    const pair: GroupNames = {
      areas: [
        { id: "a_1", slug: "one", title: "One", area: null, archived: true },
        { id: "a_2", slug: "one-2", title: "ONE", area: null },
        { id: "a_3", slug: "two", title: "Two", area: null, archived: true },
        { id: "a_4", slug: "two-2", title: "Two", area: null },
        { id: "a_5", slug: "three", title: "Three", area: null },
        { id: "a_6", slug: "three-2", title: "Three", area: null },
      ],
      projects: [],
      aliases: [],
    };
    expect(resolveGroup(pair, "area", "One", "p")).toBe("a_1");
    expect(resolveGroup(pair, "area", "ONE", "p")).toBe("a_2");
    expect(resolveGroup(pair, "area", "Two", "p")).toBe("a_4");
    // Two live groups of one name are still ambiguous: each is named by its ID.
    expect(failure(() => resolveGroup(pair, "area", "Three", "p"))).toMatchObject({
      code: "ambiguous",
      data: { suggestions: ["a_5", "a_6"] },
    });
  });

  test("similar titles: close trigrams, but other numbers are never close", () => {
    expect(similarTitles("Fix appointment timezones", "Fix appointment time zones")).toBe(true);
    expect(similarTitles("Call Jonas about the invoice", "call jonas about invoice")).toBe(true);
    expect(similarTitles("Fix DST bug in reports", "Fix appointment time zones")).toBe(false);
    expect(similarTitles("Invoice 12", "Invoice 13")).toBe(false);
    expect(similarTitles("", "")).toBe(false);
    const siblings = ["M-2", "M-3", "M-4", "M-5"].map((ref) => ({
      ref,
      title: "Fix the export",
      destination: { project: "p_1", area: null, inbox: false },
    }));
    expect(
      duplicateWarning("tasks.1", "Fix the export", { project: "p_1", area: null, inbox: false }, [
        ...siblings,
        { ...siblings[0], ref: "M-9", destination: { project: "p_2", area: null, inbox: false } },
      ] as never),
    ).toBe("tasks.1: possible duplicate of M-2, M-3, M-4 and 1 more (same project, similar title)");
    expect(
      duplicateWarning(
        "tasks.0",
        "Fix the export",
        { project: null, area: null, inbox: true },
        siblings,
      ),
    ).toBeUndefined();
  });
});
