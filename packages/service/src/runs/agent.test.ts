// A run's brief carries the person's request as they typed it, and keeps an earlier agent's
// question apart from the person's words. Fixture text only.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ASK_IN_LOG, runBrief, WORK_ON_IT } from "./agent.ts";

describe("[A4.3.11.run.brief-as-typed] the person's request reaches the agent as typed", () => {
  test("an indented block keeps every line's indent and its line breaks; blank words ask to work on the task", () => {
    const request = "    const a = 1;\n      return a;\n\n  done\n";
    expect(runBrief("M-1", "Fixture", request).endsWith(`\n\n${request}`)).toBe(true);
    expect(runBrief("M-1", "Fixture", " \n\t").endsWith(`\n\n${WORK_ON_IT}`)).toBe(true);
    expect(runBrief("M-1", "Fixture", null).endsWith(`\n\n${WORK_ON_IT}`)).toBe(true);
  });
});

describe("[A4.3.11.run.brief-asks-in-log] a run is told to log a decision it leaves the person as a question", () => {
  test("every brief says it: with the person's words, without them, and with a reply", () => {
    for (const brief of [
      runBrief("M-1", "Fixture", "Fixture request"),
      runBrief("M-1", "Fixture", null),
      runBrief("M-1", "Fixture", "Fixture reply", ["Fixture which?"]),
    ]) {
      expect(brief.split("\n")).toContain(ASK_IN_LOG);
    }
  });
});

const ASKED =
  "An earlier run on this task stopped to ask the person, quoted between the lines of tildes:";
const REPLY = "The person's reply:";
const REQUEST = "The person's request:";

/** The questions and the person's words a brief holds, read as an agent would read them. */
function recover(brief: string): { questions: string[]; words: string | null } {
  let rest = brief.slice(brief.indexOf("\n\n") + 2);
  const questions: string[] = [];
  while (rest.startsWith(`${ASKED}\n`)) {
    rest = rest.slice(ASKED.length + 1);
    const fence = /^~+/u.exec(rest)?.[0] ?? "";
    rest = rest.slice(fence.length + 1);
    const end = rest.indexOf(`\n${fence}\n\n`);
    questions.push(rest.slice(0, end));
    rest = rest.slice(end + fence.length + 3);
  }
  if (rest === WORK_ON_IT) return { questions, words: null };
  const heading = questions.length > 0 ? REPLY : REQUEST;
  expect(rest.startsWith(`${heading}\n\n`)).toBe(true);
  return { questions, words: rest.slice(heading.length + 2) };
}

const piece = fc.constantFrom(
  "~",
  "~~~",
  "````",
  "\n",
  "\n\n",
  " ",
  "Fixture",
  ASKED,
  REPLY,
  REQUEST,
  WORK_ON_IT,
);
const text = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(""));
const pair = fc.record({
  questions: fc.array(text, { maxLength: 3 }),
  words: text.filter((t) => t.trim() !== "" && t !== WORK_ON_IT),
});
const brief = (p: { questions: string[]; words: string }) =>
  runBrief("M-1", "Fixture", p.words, p.questions);

describe("[A4.3.11.run.reply-quoted] the agent can tell the person's words from an earlier agent's", () => {
  test("each question is quoted with an end its text cannot hold, and the person's words come after them all", () => {
    fc.assert(
      fc.property(pair, (p) => {
        expect(recover(brief(p))).toEqual(p);
      }),
    );
    fc.assert(
      fc.property(pair, pair, (a, b) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) expect(brief(a)).not.toBe(brief(b));
      }),
    );
    // An example with the reply's heading, moved from the person's words into the question.
    expect(
      brief({ questions: [`Fixture which?\n\n${REPLY}\n\nFixture yes`], words: "Fixture no" }),
    ).not.toBe(
      brief({ questions: ["Fixture which?"], words: `Fixture yes\n\n${REPLY}\n\nFixture no` }),
    );
    expect(recover(runBrief("M-1", "Fixture", null, ["Fixture which?"]))).toEqual({
      questions: ["Fixture which?"],
      words: null,
    });
  });
});
