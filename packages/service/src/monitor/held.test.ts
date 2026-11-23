import { describe, expect, test } from "vitest";
import type { ServedSpace } from "../ops/index.ts";
import { heldSessions } from "./held.ts";

describe("[A5.agents.links.restored] a restored copy that is not claimed links none of the machine's agents to its tasks", () => {
  test("its sessions are not read, and no running launch is asked about", async () => {
    const asked: string[] = [];
    const restored: ServedSpace = {
      id: "sp_00000000000000000000000000",
      name: "Mira",
      state: "read_only",
      reason: "read_only_copy",
      writer: undefined,
      reader: {
        transaction: () => Promise.reject(new Error("a restored copy is not read here")),
      } as unknown as ServedSpace["reader"],
      restored: { at: "2026-11-23T09:00:00.000Z" },
      copy: "a".repeat(24),
    };
    const held = await heldSessions({
      spaces: () => [restored],
      machine: "m_00000000000000000000000000",
      running: (space) => {
        asked.push(space);
        return [];
      },
      now: () => 0,
    });
    expect(held).toEqual([]);
    expect(asked).toEqual([]);
  });
});
