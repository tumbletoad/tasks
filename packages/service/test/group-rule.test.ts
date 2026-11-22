// One rule for who else may write a folder TTasks trusts (A2 3.2.2 rule 5), held twice: by the
// service (hub/permissions.ts) and by the install script (scripts/install/install.sh, between its
// `# rule: begin` and `# rule: end` lines). Both run the one table of cases in
// fixtures/group-rule.json, so they cannot drift apart: the person's own private group may write,
// every other group and every user may not, and the fix takes away only what is refused.
//
// Then the rule against a real folder of this machine: its group is this process's, so whether
// group write passes depends on whether this account's primary group is its own private group,
// and both answers are checked. A folder of a supplementary group of the account's is refused
// whatever the primary group is.
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ownGroupOf, readAccount } from "@ttasks/files/person";
import {
  currentPerson,
  factsOf,
  fixCommand,
  isOwnGroup,
  problemOf,
  repairOf,
  shellPath,
  unsafeMessage,
  type Person,
} from "../src/hub/permissions.ts";
import { tempRoot } from "./harness.ts";

interface Case {
  readonly title: string;
  readonly whose: "mine" | "above";
  readonly owner: number;
  readonly group: number;
  readonly mode: string;
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly primary: string;
  readonly verdict: "ok" | "other_owner" | "world_writable" | "group_writable";
  readonly chmod: string | null;
}

const TABLE = fileURLToPath(new URL("./fixtures/group-rule.json", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../../scripts/install/install.sh", import.meta.url));
const cases = (JSON.parse(readFileSync(TABLE, "utf8")) as { cases: Case[] }).cases;
const posix = process.platform !== "win32";

/** The person a case describes, with names for its messages. */
const personOf = (c: Case): Person => ({
  uid: c.uid,
  ownGroup: () => (isOwnGroup(c.user, c.primary) ? c.gid : undefined),
  groupName: (gid) => (gid === c.gid && c.primary !== "" ? c.primary : undefined),
});

describe("[A2.3.2.2.permissions.group-rule] one rule for group write, in the service and the install script", () => {
  test("the table has both kinds of folder and every verdict", () => {
    expect(new Set(cases.map((c) => c.whose))).toEqual(new Set(["mine", "above"]));
    expect(new Set(cases.map((c) => c.verdict))).toEqual(
      new Set(["ok", "other_owner", "world_writable", "group_writable"]),
    );
  });

  // The service judges only the folders it uses (`mine`); the folders above the install root are
  // the install script's alone.
  test.each(cases.filter((c) => c.whose === "mine"))("the service: $title", (c) => {
    const person = personOf(c);
    const facts = {
      path: "/srv/k",
      need: "folder" as const,
      kind: "folder" as const,
      uid: c.owner,
      gid: c.group,
      mode: Number.parseInt(c.mode, 8),
    };
    const problem = problemOf(facts, person);
    expect(problem ?? "ok").toBe(c.verdict);
    if (problem === undefined) return;
    expect(repairOf(facts, problem, person).chmod ?? null).toBe(c.chmod);
    if (problem === "group_writable") {
      // The message names the group, and the one command takes away only the group's write.
      const line = unsafeMessage([{ name: "The folder", facts, problem }], "Why", "ada", person);
      const group =
        c.group === c.gid && c.primary !== "" ? c.primary : `with ID ${String(c.group)}`;
      expect(line).toBe(
        `The folder (/srv/k) can be changed by the members of its group ${group}, not only by you. Why. To fix it, run: chmod g-w /srv/k`,
      );
    }
  });

  // The person's own private group is their account's primary group, asked by their user name,
  // never this process's group, which `newgrp` changes. A question that fails gives no group.
  test("the own private group is read from the account, by user name", () => {
    const account: Record<string, string> = {
      "-un": "ada",
      "-g -- ada": "1000",
      "-gn -- ada": "ada",
    };
    const asked: string[] = [];
    const ask = (answers: Record<string, string>) => (args: readonly string[]) => {
      asked.push(args.join(" "));
      return answers[args.join(" ")];
    };
    expect(readAccount(ask(account))).toEqual({ user: "ada", gid: 1000, group: "ada" });
    expect(asked).toEqual(["-un", "-g -- ada", "-gn -- ada"]);
    expect(ownGroupOf(readAccount(ask(account)))).toBe(1000);
    // A shared primary group, a group without a name, and questions that fail.
    expect(ownGroupOf(readAccount(ask({ ...account, "-gn -- ada": "staff" })))).toBeUndefined();
    const nameless = readAccount(ask({ "-un": "ada", "-g -- ada": "1000" }));
    expect(nameless).toEqual({ user: "ada", gid: 1000, group: undefined });
    expect(ownGroupOf(nameless)).toBeUndefined();
    expect(readAccount(ask({}))).toBeUndefined();
    expect(readAccount(ask({ ...account, "-g -- ada": "1000x" }))).toBeUndefined();
  });

  // The script's own block, run alone by the system's sh over each case's facts.
  test.runIf(posix).each(cases)("the install script: $title", (c) => {
    const script = readFileSync(SCRIPT, "utf8");
    const block = /^# rule: begin\n([\s\S]*?)^# rule: end$/mu.exec(script)?.[1];
    expect(block, "install.sh holds the rule between its markers").toBeDefined();
    const ran = spawnSync(
      "/bin/sh",
      [
        "-c",
        `set -eu\n${block ?? ""}\nme=$1\nown_gid=$(own_group "$2" "$3" "$4")\njudge "$5" "$6" "$7" "$8"`,
        "sh",
        String(c.uid),
        c.user,
        String(c.gid),
        c.primary,
        c.whose,
        String(c.owner),
        String(c.group),
        c.mode,
      ],
      { encoding: "utf8", env: { LC_ALL: "C" } },
    );
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    const said = ran.stdout.trim();
    const [verdict, chmod] = said === "" ? ["ok", "-"] : said.split(" ");
    expect(verdict).toBe(c.verdict);
    expect(chmod === "-" ? null : chmod).toBe(c.chmod);
  });
});

describe.runIf(posix)(
  "[A2.3.2.2.permissions.group-rule] the rule against a real folder of this machine",
  () => {
    let temp: ReturnType<typeof tempRoot> | undefined;
    beforeAll(() => {
      temp = tempRoot("gr");
    });
    afterAll(() => {
      temp?.cleanup();
    });

    test("group write by this account's group passes exactly when that group is its own private group", () => {
      const person = currentPerson();
      if (person === undefined) throw new Error("no person on a POSIX host");
      const dir = join(temp?.root ?? "", "own");
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o775);
      const facts = factsOf(dir, "folder", { followLink: false });
      if (typeof facts !== "object") throw new Error(`no facts for ${dir}`);
      // The account's primary group and its name, as the install script asks them.
      const id = (...args: string[]) =>
        spawnSync("id", args, { encoding: "utf8" }).stdout.replace(/\n$/u, "");
      const user = id("-un");
      const primary = Number(id("-g", "--", user));
      const ownId = isOwnGroup(user, id("-gn", "--", user)) ? primary : undefined;
      expect(person.ownGroup()).toBe(ownId);
      // A new folder's group is the account's primary group, unless a setgid folder above it or a
      // `newgrp` shell gave it another.
      const own = ownId !== undefined && ownId === facts.gid;
      if (own) {
        expect(problemOf(facts, person)).toBeUndefined();
      } else {
        expect(problemOf(facts, person)).toBe("group_writable");
        expect(fixCommand([{ facts, problem: "group_writable" }], "ada", person)).toBe(
          `chmod g-w ${shellPath(dir)}`,
        );
      }
      // Every user's write is refused either way, and the fix leaves the private group's.
      chmodSync(dir, 0o777);
      const open = factsOf(dir, "folder", { followLink: false });
      if (typeof open !== "object") throw new Error(`no facts for ${dir}`);
      expect(problemOf(open, person)).toBe("world_writable");
      expect(fixCommand([{ facts: open, problem: "world_writable" }], "ada", person)).toBe(
        `chmod ${own ? "o-w" : "go-w"} ${shellPath(dir)}`,
      );
    });

    // A group of the account's other than its primary one, which the account may give a folder.
    const supplementary = posix
      ? process.getgroups?.().find((g) => g !== process.getegid?.() && g !== 0)
      : undefined;
    test.runIf(supplementary !== undefined)(
      "a folder another group of this account's may write is refused, named with that group, and its command fixes it",
      () => {
        const person = currentPerson();
        if (person === undefined || supplementary === undefined) throw new Error("no group");
        // In a `newgrp` shell the account's own private group is a supplementary one: not this case.
        if (supplementary === person.ownGroup()) return;
        const dir = join(temp?.root ?? "", "shared");
        mkdirSync(dir, { mode: 0o700 });
        chownSync(dir, person.uid, supplementary);
        chmodSync(dir, 0o775);
        const facts = factsOf(dir, "folder", { followLink: false });
        if (typeof facts !== "object") throw new Error(`no facts for ${dir}`);
        expect(problemOf(facts, person)).toBe("group_writable");
        const line = unsafeMessage(
          [{ name: "The folder", facts, problem: "group_writable" }],
          "Why",
        );
        // Its name as the account services give it, or its ID when a line cannot show the name.
        const name = person.groupName(supplementary);
        expect([name, `with ID ${String(supplementary)}`]).toContain(
          /can be changed by the members of its group (.+), not only by you/u.exec(line)?.[1],
        );
        const command = /To fix it, run: (.*)$/u.exec(line)?.[1];
        expect(command).toBe(`chmod g-w ${shellPath(dir)}`);
        const ran = spawnSync("/bin/sh", ["-c", command ?? "false"], { encoding: "utf8" });
        expect(ran.status, ran.stderr).toBe(0);
        const after = factsOf(dir, "folder", { followLink: false });
        if (typeof after !== "object") throw new Error(`no facts for ${dir}`);
        expect(problemOf(after, person)).toBeUndefined();
      },
    );
  },
);
