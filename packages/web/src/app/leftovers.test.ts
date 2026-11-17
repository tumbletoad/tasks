// @vitest-environment happy-dom
//
// The kept text of a task gone for good is forgotten when its space opens (leftovers.ts); a task
// the service still knows, finished or not, keeps it, and so does one it could not ask about.
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
            return Promise.reject(error as Error);
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

describe("[A5.3.8.web.leftovers] the kept text of a task gone for good is forgotten when its space opens", () => {
  test("a gone task's draft and waiting edit go; a known, finished or unreachable task keeps its own", async () => {
    for (const task of ["tk_live", "tk_done", "tk_gone", "tk_down", "nonsense"]) {
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
    expect(asked.sort()).toEqual(["nonsense", "tk_done", "tk_down", "tk_gone"]);
    expect(draftTasks(SPACE).sort()).toEqual(["tk_done", "tk_down", "tk_live"]);
    expect(unsavedTasks(SPACE)).toEqual([]);
  });
});
