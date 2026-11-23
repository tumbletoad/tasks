// @vitest-environment happy-dom
//
// The kept text of a space's tasks when the space opens (leftovers.ts): a task the service knows,
// finished, in the Trash or not, keeps it; so does one the space does not have now (a backup
// restored over it), whose words the Trash lists until the person discards them, and one it could
// not ask about. Only text under a key of no task's shape is forgotten.
import { beforeEach, describe, expect, test } from "vitest";
import type { Api } from "../api.ts";
import { titleChange } from "../edit/change.ts";
import { unsavedKeeper, unsavedTasks } from "../edit/keep.ts";
import { draftTasks, keepDraft } from "../task/composer.ts";
import { forgetGone } from "./leftovers.ts";

const SPACE = "sp_0123456789abcdefghjkmnpqrs";

const refusal = (code: string) => Object.assign(new Error(code), { code });

/** A service that knows `known`, has never heard of `gone`, and cannot answer for `down`. */
function apiOf(answers: Record<string, () => unknown>): { api: Api; asked: string[] } {
  const asked: string[] = [];
  const api = {
    client: {
      task: {
        get: ({ task }: { task: string }) => {
          asked.push(task);
          try {
            return Promise.resolve(answers[task]?.());
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      },
    },
  } as unknown as Api;
  return { api, asked };
}

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.8.web.leftovers] the kept text of a space's tasks when the space opens", () => {
  test("only a key of no task's shape loses its text; a gone, trashed, finished or unreachable task keeps its own", async () => {
    for (const task of ["tk_live", "tk_done", "tk_trash", "tk_gone", "tk_down", "nonsense"]) {
      keepDraft(SPACE, task, `Draft of ${task}`);
    }
    unsavedKeeper(SPACE).save(
      new Map([
        [
          "tk_gone\u0000title",
          {
            task: "tk_gone",
            ref: "M-9",
            field: "title",
            change: titleChange("x"),
            reason: "failed",
          },
        ],
      ]),
    );
    const { api, asked } = apiOf({
      tk_done: () => ({ task: { lifecycle: "completed" } }),
      tk_trash: () => ({ task: { lifecycle: "active", deleted: { at: "x", by: "user" } } }),
      tk_gone: () => {
        throw refusal("not_found");
      },
      tk_down: () => {
        throw refusal("service_unavailable");
      },
      nonsense: () => {
        throw refusal("invalid_input");
      },
    });
    // The live rows hold the active task: it is not asked about.
    await forgetGone(SPACE, api, (task) => task === "tk_live");
    expect(asked.sort()).toEqual(["nonsense", "tk_done", "tk_down", "tk_gone", "tk_trash"]);
    expect(draftTasks(SPACE).sort()).toEqual([
      "tk_done",
      "tk_down",
      "tk_gone",
      "tk_live",
      "tk_trash",
    ]);
    expect(unsavedTasks(SPACE)).toEqual(["tk_gone"]);
  });

  test("many finished tasks with drafts do not keep a key of no task's shape from being forgotten", async () => {
    const finished = Array.from({ length: 30 }, (_, i) => `tk_done${String(i).padStart(2, "0")}`);
    for (const task of finished) keepDraft(SPACE, task, `Draft of ${task}`);
    keepDraft(SPACE, "tk_zbroken", "Draft under a broken key");
    const answers: Record<string, () => unknown> = {
      tk_zbroken: () => {
        throw refusal("invalid_input");
      },
    };
    for (const task of finished) answers[task] = () => ({ task: { lifecycle: "completed" } });
    const { api, asked } = apiOf(answers);
    for (let opening = 0; opening < 20 && draftTasks(SPACE).includes("tk_zbroken"); opening += 1) {
      asked.length = 0;
      await forgetGone(SPACE, api, () => false);
      expect(asked.length).toBeLessThanOrEqual(20);
    }
    expect(draftTasks(SPACE)).not.toContain("tk_zbroken");
    expect(draftTasks(SPACE)).toHaveLength(30);
  });
});
