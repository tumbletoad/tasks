// @vitest-environment happy-dom
//
// A working run's entry (RunBody.tsx), rendered by React into happy-dom: a run that has said nothing
// for a while says so after its Stop, in the state's own line, so Stop stays where it is when the
// words come and nothing under the line moves. Fixture data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { Run } from "../api.ts";
import { I18n } from "../i18n/intl.tsx";
import { RunBody } from "./RunBody.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (patch: Partial<Run> = {}): Run => ({
  id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
  instance: "codex-work",
  state: "running",
  reason: null,
  queued_at: 1_000,
  started_at: 1_100,
  ended_at: null,
  asked: null,
  answer: null,
  answer_final: false,
  answer_cut: false,
  version: 4,
  ...patch,
});

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
});

function draw(shown: Run): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18n>
        <RunBody run={shown} label="Codex · work" onStop={() => undefined} />
      </I18n>,
    );
  });
  const line = host.querySelector<HTMLElement>('[data-part="run-state"]');
  if (line === null) throw new Error("no state line");
  return line;
}

describe("[M6.page.run-words] a run's entry says what is the case and what the person can do", () => {
  test("a run quiet for two minutes says so in its state's line, after Stop", () => {
    const line = draw(run({ quiet_since: Date.now() - 2 * 60_000 - 5_000 }));
    const parts = [...line.children].map(
      (child) => child.getAttribute("data-part") ?? child.tagName.toLowerCase(),
    );
    expect(parts).toEqual(["span", "run-stop", "run-quiet"]);
    expect(line.querySelector('[data-part="run-quiet"]')?.textContent).toContain(
      "It has said nothing for 2 minutes",
    );
    expect(host?.querySelectorAll('[data-part="run-quiet"]')).toHaveLength(1);
  });

  test("a run that spoke within the minute shows no such words", () => {
    const line = draw(run({ quiet_since: Date.now() - 30_000 }));
    expect(line.querySelector('[data-part="run-quiet"]')).toBeNull();
  });
});
