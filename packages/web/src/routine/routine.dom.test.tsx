// @vitest-environment happy-dom
//
// A routine's row and the Routines page's lists: the round box with its loop checks off this time
// and never finishes the routine, the line names the schedule, who does it and when, and the lists
// are Due, Coming and Paused. Fixture data only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RoutineRow } from "@ttasks/client/store";
import type { Clock } from "@ttasks/client/today";
import { I18n } from "../i18n/intl.tsx";
import { NewRoutine } from "./NewRoutine.tsx";
import { RoutineLists, type RoutineActions } from "./Routine.tsx";
import { RoutineCard, type RoutineCardActions, type RoutineEntryView } from "./RoutineCard.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Wednesday 9 December 2026, 10:00 in Amsterdam. */
const CLOCK: Clock = {
  today: "2026-12-09",
  now: Date.UTC(2026, 11, 9, 9, 0),
  timeZone: "Europe/Amsterdam",
  locale: "en-GB",
};

let n = 0;
const routine = (patch: Partial<RoutineRow>): RoutineRow => {
  n += 1;
  return {
    id: `t_r${String(n).padStart(4, "0")}`,
    ref: `M-${String(n)}`,
    kind: "routine",
    title: `Routine ${String(n)}`,
    parent: "sp_a",
    position: "a",
    priority: 4,
    lifecycle: "active",
    rule: "FREQ=WEEKLY;BYDAY=SA",
    start: "2026-11-01",
    tz: "Europe/Amsterdam",
    due_date: "2026-12-12",
    paused: false,
    by: "you",
    entries: 0,
    version: 1,
    ...patch,
  };
};

let container: HTMLDivElement;
let root: Root;
const done: string[] = [];
const skipped: string[] = [];
const actions: RoutineActions = {
  done: (r) => done.push(r.title),
  skip: (r) => skipped.push(r.title),
};

beforeEach(() => {
  done.length = 0;
  skipped.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const show = (routines: RoutineRow[]) => {
  act(() => {
    root.render(
      <I18n>
        <RoutineLists routines={routines} clock={CLOCK} actions={actions} />
      </I18n>,
    );
  });
};
const lines = (part: string) =>
  [...container.querySelectorAll(`[data-part="${part}"] [data-part="routine"]`)].map((row) =>
    [
      row.querySelector("[data-part=routine] > div > div")?.textContent,
      ...[...row.querySelectorAll('[data-part="routine-part"]')].map((p) => p.textContent),
    ].join(" · "),
  );

describe("[A5.routines.web.lists] a routine's row and the Routines page's lists", () => {
  test("Due, Coming and Paused, each line its schedule, who does it, when, and its newest entry", () => {
    show([
      routine({
        title: "Water the plants",
        due_date: "2026-12-05",
        last_state: "done",
        // Done on Friday for its Saturday: the line says the day it was done.
        last_at: Date.UTC(2026, 10, 27, 9),
        last_due: "2026-11-28",
      }),
      routine({ title: "Take out the bins", rule: "FREQ=WEEKLY;BYDAY=WE", due_date: "2026-12-09" }),
      routine({ title: "Weekly review", rule: "FREQ=WEEKLY;BYDAY=FR", due_date: "2026-12-11" }),
      routine({ title: "Back up the photos", paused: true }),
      routine({ title: "Done for good", lifecycle: "completed" }),
    ]);
    expect(lines("routines-due")).toEqual([
      "Water the plants · Every Saturday · you · late since Sat 5 Dec · last done Fri 27 Nov",
      "Take out the bins · Every Wednesday · you · today",
    ]);
    expect(lines("routines-coming")).toEqual([
      "Weekly review · Every Friday · you · next Fri 11 Dec",
    ]);
    expect(lines("routines-paused")).toEqual(["Back up the photos · Every Saturday · you"]);
    expect(container.querySelector('[data-part="routines-paused"] h2')?.textContent).toBe(
      "Paused (1)",
    );
  });

  test("the round box checks off this time and Skip skips it; neither is offered as a finish", () => {
    show([routine({ title: "Water the plants", due_date: "2026-12-05" })]);
    const box = container.querySelector<HTMLButtonElement>('[data-part="routine-check"]');
    expect(box?.getAttribute("aria-label")).toBe("Done for this time: Water the plants");
    expect(box?.querySelector("svg")).not.toBeNull();
    act(() => {
      box?.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-part="routine-skip"]')?.click();
    });
    expect(done).toEqual(["Water the plants"]);
    expect(skipped).toEqual(["Water the plants"]);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe("[A5.routines.web.card] a routine's card: its title and schedule corrected in place, its times done, Pause, and Finish behind its dialog", () => {
  const paused: string[] = [];
  const finished: string[] = [];
  const changed: string[] = [];
  let answer = true;
  const cardActions: RoutineCardActions = {
    pause: (r) => paused.push(`pause ${r.title}`),
    resume: (r) => paused.push(`resume ${r.title}`),
    finish: (r) => finished.push(r.title),
    change: (_r, change) => {
      changed.push(JSON.stringify(change));
      return Promise.resolve(answer);
    },
  };
  const card = (r: RoutineRow, entries: RoutineEntryView[]) => {
    act(() => {
      root.render(
        <I18n>
          <RoutineCard routine={r} entries={entries} clock={CLOCK} actions={cardActions} />
        </I18n>,
      );
    });
  };
  const entryLines = () =>
    [...container.querySelectorAll('[data-part="routine-entry"]')].map((li) =>
      [...li.querySelectorAll("span")].map((s) => s.textContent).join(" · "),
    );
  const field = (part: string) =>
    container.querySelector<HTMLInputElement>(`[data-part="${part}"]`);
  const type = (input: HTMLInputElement | null, value: string) => {
    if (input === null) throw new Error("no field");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const enter = async (input: HTMLInputElement | null) => {
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
  };

  test("the times done, newest first, each on the day it was done and for its own day when another", () => {
    card(routine({ title: "Water the plants", entries: 3 }), [
      {
        due: { date: "2026-12-05" },
        state: "skipped",
        why: "you",
        at: "2026-12-05T10:00:00.000Z",
        by: "user",
      },
      { state: "done", at: "2026-12-02T18:00:00.000Z", by: "user" },
      {
        due: { date: "2026-11-28" },
        state: "done",
        at: "2026-11-27T09:00:00.000Z",
        by: "user",
        note: "The fern too",
      },
    ]);
    expect(entryLines()).toEqual([
      "Sat 5 Dec · skipped",
      "Wed 2 Dec · an extra time",
      "Fri 27 Nov · for Sat 28 Nov · The fern too",
    ]);
    // What the row above says is not said again: the card holds its fields instead.
    expect(container.querySelector('[data-part="routine-card"]')?.textContent).not.toContain("you");
  });

  test("its title and its schedule are corrected in place; words that are no schedule save nothing, and a refusal keeps them", async () => {
    changed.length = 0;
    card(routine({ title: "Water the plants" }), []);
    expect(field("routine-schedule")?.value).toBe("Every Saturday");
    type(field("routine-title"), "Water the ferns");
    await enter(field("routine-title"));
    type(field("routine-schedule"), "now and then");
    expect(container.querySelector('[data-part="routine-schedule-preview"]')?.textContent).toBe(
      "Not a schedule: try every saturday or weekdays at 7",
    );
    await enter(field("routine-schedule"));
    answer = false;
    type(field("routine-schedule"), "every sunday");
    expect(container.querySelector('[data-part="routine-schedule-preview"]')?.textContent).toBe(
      "Every Sunday",
    );
    await enter(field("routine-schedule"));
    answer = true;
    expect(changed).toEqual(['{"title":"Water the ferns"}', '{"rule":"FREQ=WEEKLY;BYDAY=SU"}']);
    expect(field("routine-schedule")?.value).toBe("every sunday");
  });

  test("Pause, then Finish routine… asks first, and Cancel finishes nothing", () => {
    paused.length = 0;
    finished.length = 0;
    card(routine({ title: "Weekly review", entries: 23 }), []);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-part="routine-pause"]')?.click();
    });
    expect(paused).toEqual(["pause Weekly review"]);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-part="routine-finish"]')?.click();
    });
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Finish Weekly review for good?");
    expect(dialog?.textContent).toContain(
      "It stops coming back. Its 23 entries stay with it in Completed.",
    );
    expect(finished).toEqual([]);
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-part="routine-finish-confirm"]')?.click();
    });
    expect(finished).toEqual(["Weekly review"]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("a finished routine's card shows its times done only", () => {
    card(routine({ title: "Weekly review", lifecycle: "completed" }), [
      { due: { date: "2026-12-04" }, state: "done", at: "2026-12-04T15:00:00.000Z", by: "user" },
    ]);
    expect(entryLines()).toEqual(["Fri 4 Dec"]);
    expect(field("routine-title")).toBeNull();
    expect(container.querySelector('[data-part="routine-finish"]')).toBeNull();
  });
});

describe("[A5.routines.web.new] + New routine reads its schedule as the person types and makes it", () => {
  const type = (input: HTMLInputElement | null, value: string) => {
    if (input === null) throw new Error("no field");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  test("the words read as a schedule, words that are none say so, and Make sends the rule", async () => {
    const made: string[] = [];
    act(() => {
      root.render(
        <I18n>
          <NewRoutine
            clock={CLOCK}
            onMake={(title, rule) => {
              made.push(`${title} ${rule}`);
              return Promise.resolve(true);
            }}
          />
        </I18n>,
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-part="routine-new"]')?.click();
    });
    const field = (part: string) =>
      container.querySelector<HTMLInputElement>(`[data-part="${part}"]`);
    const preview = () => container.querySelector('[data-part="routine-new-preview"]')?.textContent;
    const save = () => container.querySelector<HTMLButtonElement>('[data-part="routine-new-save"]');
    type(field("routine-new-title"), "Water the plants");
    type(field("routine-new-schedule"), "now and then");
    expect(preview()).toBe("Not a schedule: try every saturday or weekdays at 7");
    expect(save()?.disabled).toBe(true);
    type(field("routine-new-schedule"), "every saturday");
    expect(preview()).toBe("Every Saturday");
    await act(async () => {
      save()?.click();
      await Promise.resolve();
    });
    expect(made).toEqual(["Water the plants FREQ=WEEKLY;BYDAY=SA"]);
    expect(container.querySelector('[data-part="routine-new-form"]')).toBeNull();
  });

  test("Make pressed twice while the first is on its way makes one routine, and a refusal keeps the words", async () => {
    const made: string[] = [];
    let settle: (saved: boolean) => void = () => undefined;
    act(() => {
      root.render(
        <I18n>
          <NewRoutine
            clock={CLOCK}
            onMake={(title) => {
              made.push(title);
              return new Promise<boolean>((resolve) => {
                settle = resolve;
              });
            }}
          />
        </I18n>,
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-part="routine-new"]')?.click();
    });
    const field = (part: string) =>
      container.querySelector<HTMLInputElement>(`[data-part="${part}"]`);
    type(field("routine-new-title"), "Water the plants");
    type(field("routine-new-schedule"), "every saturday");
    const save = () => container.querySelector<HTMLButtonElement>('[data-part="routine-new-save"]');
    act(() => {
      save()?.click();
    });
    act(() => {
      save()?.click();
    });
    expect(made).toEqual(["Water the plants"]);
    await act(async () => {
      settle(false);
      await Promise.resolve();
    });
    expect(field("routine-new-title")?.value).toBe("Water the plants");
    expect(field("routine-new-schedule")?.value).toBe("every saturday");
  });
});
