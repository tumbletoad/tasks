// A run's brief carries the person's request as they typed it. Fixture text only.
import { describe, expect, test } from "vitest";
import { runBrief, WORK_ON_IT } from "./agent.ts";

describe("[A4.3.11.run.brief-as-typed] the person's request reaches the agent as typed", () => {
  test("an indented block keeps every line's indent and its line breaks; blank words ask to work on the task", () => {
    const request = "    const a = 1;\n      return a;\n\n  done\n";
    expect(runBrief("M-1", "Fixture", request).endsWith(`\n\n${request}`)).toBe(true);
    expect(runBrief("M-1", "Fixture", " \n\t").endsWith(`\n\n${WORK_ON_IT}`)).toBe(true);
    expect(runBrief("M-1", "Fixture", null).endsWith(`\n\n${WORK_ON_IT}`)).toBe(true);
  });
});
