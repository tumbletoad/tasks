// Which copy of a space an ID or a name means (A2 3.10.5): the one rule every lookup uses. Fixture
// folders only.
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ambiguousError,
  chooseCopy,
  copyOf,
  findSpace,
  isAmbiguity,
  onlySpace,
  type Copy,
} from "./copies.ts";

const MIRA = "sp_43f0gjcvzgaa1gh5my6qxwcj7m";
const LIFE = "sp_3z8sm956jp8dajmtsar5kx026c";
const root = resolve("fixture-root");
const at = (name: string) => join(root, name);

const space = (
  id: string,
  folder: string,
  state: string,
  reason?: string,
  name = id === MIRA ? "Mira" : "Life",
): Copy => ({ id, name, state, folder: at(folder), ...(reason === undefined ? {} : { reason }) });

describe("[A2.3.10.5.copies.rule] the copy an ID or a name means", () => {
  test("the writable copy wins over read-only copies, by ID, by name and as the one space", () => {
    const original = space(MIRA, "mira", "open");
    const copy = space(MIRA, "mira-copy", "read_only", "read_only_copy");
    // Either order: never the first one listed.
    for (const spaces of [
      [copy, original],
      [original, copy],
    ]) {
      expect(copyOf(spaces, MIRA)).toBe(original);
      expect(findSpace(spaces, MIRA)).toBe(original);
      expect(findSpace(spaces, "mira")).toBe(original);
      expect(onlySpace(spaces)).toBe(original);
      // A folder names its own copy.
      expect(findSpace(spaces, at("mira-copy"))).toBe(copy);
    }
  });

  test("a closed original never stands in for the claimed copy, and with no writable copy the space itself comes before a restored copy", () => {
    const closed = space(MIRA, "mira", "closed");
    const claimed = space(MIRA, "mira-copy", "open");
    expect(copyOf([closed, claimed], MIRA)).toBe(claimed);
    const synced = space(MIRA, "mira", "read_only", "synced_folder");
    const restored = space(MIRA, "mira-copy", "read_only", "read_only_copy");
    expect(copyOf([restored, synced], MIRA)).toBe(synced);
    const missing = space(MIRA, "mira", "unavailable", "missing");
    expect(copyOf([missing, restored], MIRA)).toBe(restored);
    // Opening or closing for a moment comes before read-only: the answer is "retry".
    const opening = space(MIRA, "mira", "opening");
    expect(copyOf([restored, opening], MIRA)).toBe(opening);
    expect(chooseCopy([space(MIRA, "a", "opening"), space(MIRA, "b", "opening")])).toMatchObject({
      state: "opening",
    });
  });

  test("two copies equally good are ambiguous and the error names both folders; a name of two spaces is ambiguous by name", () => {
    const one = space(MIRA, "copy-one", "read_only", "read_only_copy");
    const two = space(MIRA, "copy-two", "read_only", "read_only_copy");
    const found = copyOf([one, two], MIRA);
    expect(isAmbiguity(found)).toBe(true);
    if (!isAmbiguity(found)) throw new Error("not ambiguous");
    const error = ambiguousError(found);
    expect(error.code).toBe("ambiguous");
    expect(error.message).toContain(at("copy-one"));
    expect(error.message).toContain(at("copy-two"));
    expect(error.data).toEqual({ folders: [at("copy-one"), at("copy-two")] });

    const other = space(LIFE, "life", "open", undefined, "Mira");
    const byName = findSpace([space(MIRA, "mira", "open"), other], "Mira");
    expect(isAmbiguity(byName) && byName.ambiguous).toBe("name");
    expect(onlySpace([space(MIRA, "mira", "open"), other])).toBe("several");
    expect(onlySpace([])).toBeUndefined();
    expect(findSpace([other], "Nothing")).toBeUndefined();
  });

  test("a folder is compared as the OS compares names, and a name that looks like a path is never a name", () => {
    const named = { ...space(MIRA, "mira", "open"), name: at("life") };
    const life = space(LIFE, "life", "open");
    expect(findSpace([named, life], at("life"))).toBe(life);
    const folded = findSpace([life], at("LIFE"));
    if (process.platform === "win32" || process.platform === "darwin") expect(folded).toBe(life);
    else expect(folded).toBeUndefined();
  });
});
