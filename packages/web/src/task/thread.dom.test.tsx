// @vitest-environment happy-dom
//
// A launch's request in the thread (Thread.tsx), rendered by React into happy-dom: the note the
// launch names shows in its session's entry as what the person asked, a launch that did not open
// offers to open again with it, and a request whose session is not listed shows on its own as one.
// Fixture data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Instance, Receipt, ReceiptState } from "../api.ts";
import { I18n } from "../i18n/intl.tsx";
import type { DetailNote } from "./detail.ts";
import { Thread } from "./Thread.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: Instance = {
  key: "claude",
  label: "Claude Code · work",
  glyph: "Cc",
  ring: 1,
  route: "terminal",
};

const AT = Date.UTC(2026, 10, 12, 10, 0);

function receipt(id: string, reference: string, state: ReceiptState, at: number): Receipt {
  return {
    id,
    reference,
    instance: "claude",
    route: "terminal",
    state,
    reason: state === "failed" ? "path_missing" : null,
    at: { prepared: at, ...(state === "prepared" ? {} : { [state]: at + 1_000 }) },
  };
}

function note(ref: string, text: string, launches: readonly string[], at = AT): DetailNote {
  return {
    kind: "note",
    ref,
    author: "user",
    at: new Date(at).toISOString(),
    text,
    forAgents: false,
    ...(launches.length === 0
      ? {}
      : { requestFor: launches.map((launch) => ({ launch, instance: "claude" })) }),
  };
}

let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

function render(
  notes: readonly DetailNote[],
  receipts: readonly Receipt[],
  onOpenAgain?: (note: DetailNote, instance: Instance) => void,
): void {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <I18n>
        <Thread
          notes={notes}
          log={[]}
          receipts={receipts}
          instances={[CLAUDE]}
          partial={false}
          {...(onOpenAgain === undefined ? {} : { onOpenAgain })}
        />
      </I18n>,
    );
  });
}

const entries = () => [...host.querySelectorAll<HTMLElement>("[data-entry]")];
const askedIn = (entry: HTMLElement | undefined) =>
  entry?.querySelector("[data-part='asked']")?.textContent ?? undefined;

describe("[A5.3.9.web.thread-request] a launch's request shows in the thread as what the person asked its agent", () => {
  test("in its session's entry, from the click on, and not again as a note; gone with its note", () => {
    const asked = note("n2", "Check the clinic export first", ["L7KQ21"]);
    render([asked], [receipt("la_1", "L7KQ21", "prepared", AT)]);
    // Prepared says no state yet, but what was asked is there at once.
    expect(entries().map((e) => e.dataset["entry"])).toEqual(["session"]);
    expect(askedIn(entries()[0])).toBe("You asked: Check the clinic export first");

    render([asked], [receipt("la_1", "L7KQ21", "confirmed", AT)]);
    expect(entries()).toHaveLength(1);
    expect(askedIn(entries()[0])).toContain("Check the clinic export first");
    expect(entries()[0]?.textContent).toContain("Open in Claude Code · work");
    expect(host.querySelector("[data-part='open-again']")).toBeNull();

    // The note was read before the launch was recorded: the receipt names it all the same.
    const early = note("n3", "Then fix the offset", []);
    render([early], [{ ...receipt("la_1", "L7KQ21", "dispatching", AT), request: "n3" }]);
    expect(entries().map((e) => e.dataset["entry"])).toEqual(["session"]);
    expect(askedIn(entries()[0])).toBe("You asked: Then fix the offset");

    // An undo took the note back: the session stays, without words.
    render([], [receipt("la_1", "L7KQ21", "confirmed", AT)]);
    expect(entries()).toHaveLength(1);
    expect(askedIn(entries()[0])).toBeUndefined();
  });

  test("a launch that did not open offers to open again with its request, on its newest launch only", () => {
    const asked = note("n2", "Check the clinic export first", ["L7KQ21", "L8MN32"]);
    const opened: [string, string][] = [];
    render(
      [asked],
      [receipt("la_1", "L7KQ21", "failed", AT), receipt("la_2", "L8MN32", "failed", AT + 60_000)],
      (n, instance) => opened.push([n.ref, instance.key]),
    );
    const again = [...host.querySelectorAll<HTMLButtonElement>("[data-part='open-again']")];
    expect(again).toHaveLength(1);
    expect(again[0]?.closest("[data-entry]")?.getAttribute("data-entry-key")).toBe("r:la_2");
    expect(again[0]?.getAttribute("aria-label")).toBe(
      "Open Claude Code · work again with this request",
    );
    act(() => {
      again[0]?.click();
    });
    expect(opened).toEqual([["n2", "claude"]]);
  });

  test("a request whose session is not listed shows on its own, as asked of its agent", () => {
    render([note("n1", "Plain note", []), note("n2", "Book the van", ["L7KQ21"], AT + 1)], []);
    const [plain, request] = entries();
    expect(plain?.textContent).not.toContain("asked");
    expect(request?.dataset["entry"]).toBe("note");
    expect(request?.textContent).toContain("asked Claude Code · work");
    expect(request?.textContent).toContain("Book the van");
  });
});
