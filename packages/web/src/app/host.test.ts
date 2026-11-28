import { describe, expect, test } from "vitest";
import { hostOf, type HostFacts } from "./host.ts";

const active = (more: Partial<HostFacts> = {}): HostFacts => ({
  lifecycle: "active",
  inbox: false,
  status: "open",
  ...more,
});

describe("[A5.3.3.web.task-host] a task link's host view, for every kind of task", () => {
  test.each([
    ["active, in Inbox", active({ inbox: true, project: "ar_1" }), { kind: "view", view: "inbox" }],
    ["active, in a project", active({ project: "pj_1" }), { kind: "project", project: "pj_1" }],
    [
      "active, in no project, waiting",
      active({ status: "waiting" }),
      { kind: "view", view: "waiting" },
    ],
    [
      "active, in no project, review",
      active({ status: "review" }),
      { kind: "view", view: "review" },
    ],
    [
      "active, in no project, backlog",
      active({ status: "backlog" }),
      { kind: "view", view: "backlog" },
    ],
    ["active, another status", active({ status: "someday" }), { kind: "view", view: "open" }],
    [
      "completed",
      active({ lifecycle: "completed", project: "ar_1" }),
      { kind: "view", view: "completed" },
    ],
    [
      "archived (dropped)",
      active({ lifecycle: "archived", inbox: true }),
      { kind: "view", view: "completed" },
    ],
    ["deleted, restorable", active({ deleted: true, lifecycle: "completed" }), { kind: "trash" }],
    ["purged or unknown", undefined, { kind: "gone" }],
  ] as const)("%s", (_name, facts, host) => {
    expect(hostOf(facts)).toEqual(host);
  });
});
