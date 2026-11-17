// The cases the end-to-end tests' fake Codex plays (fake-codex.ts), and what it says in them, for
// the tests to look for. Fixture data only. Tests only.

/**
 * - `answer`: the plain recording; the final answer says what the brief asked for, the request last
 * - `long`: the same, with an answer of eighty lines
 * - `ask`: a blocking question for the person, which the driver turns into "needs you"
 * - `fail`: the turn fails as a signed-out Codex's does
 * - `hold`: works until Stop interrupts its turn
 */
export type FakeCodexCase = "answer" | "long" | "ask" | "fail" | "hold";

/** The answer of `answer` and `long`, for the request the brief ends with. */
export function fakeAnswer(request: string, long = false): string {
  const lines = long
    ? Array.from({ length: 80 }, (_, i) => `${String(i + 1)}. Checked part ${String(i + 1)}.`)
    : ["Checked the portal's appointment times.", "", "- They match since Sunday."];
  return [...lines, "", `Asked: ${request}`].join("\n");
}

export const FAKE_QUESTION = "Which month should the export cover?";

/** What the signed-out case's turn says. */
export const FAKE_SIGNED_OUT = "401 Unauthorized: not logged in.";
