// Which copy of a space an ID or a name means (A2 3.10.5): the one rule every lookup uses. Fixture
// folders only.
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addressOf,
  ambiguousError,
  chooseCopy,
  copyKey,
  copyOf,
  findSpace,
  isAmbiguity,
  namesCopy,
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
    // A copy not served yet (its folder gone) has no ID read from its folder, but its entry's ID
    // makes it a copy of the space: still one space served.
    const gone: Copy = {
      id: undefined,
      registered: MIRA,
      state: "unavailable",
      reason: "missing",
      folder: at("look"),
    };
    expect(onlySpace([gone, original])).toBe(original);
    expect(onlySpace([gone, space(LIFE, "life", "open")])).toBe("several");
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

  test("the page names each copy so that it never reaches another: the ID for the copy it means, a key for a restored copy and for a copy the ID does not mean", () => {
    const original = space(MIRA, "mira", "open");
    const copy = space(MIRA, "mira-copy", "read_only", "read_only_copy");
    const spaces = [copy, original];
    expect(addressOf(spaces, original)).toBe(MIRA);
    const key = addressOf(spaces, copy) ?? "";
    expect(key).toBe(copyKey(MIRA, at("mira-copy")));
    expect(key).toMatch(/^sp_[0-9a-z]{26}-copy-[0-9a-f]{12}$/u);
    expect(namesCopy(key)).toBe(true);
    expect(namesCopy(MIRA)).toBe(false);
    expect(findSpace(spaces, key)).toBe(copy);
    expect(findSpace(spaces, MIRA)).toBe(original);
    // A restored copy keeps its key while it is the only copy, so a tab on it never moves to an
    // original that opens later; claimed, the space's ID means it, and its key still reaches it.
    expect(addressOf([copy], copy)).toBe(key);
    const claimed = space(MIRA, "mira-copy", "open");
    const closed = space(MIRA, "mira", "closed");
    expect(addressOf([closed, claimed], claimed)).toBe(MIRA);
    expect(findSpace([closed, claimed], key)).toBe(claimed);
    // The original beside a claimed copy that writes is named by its own key.
    const behind = space(MIRA, "mira", "read_only", "not_authority");
    expect(addressOf([behind, claimed], behind)).toBe(copyKey(MIRA, at("mira")));
    // A copy opening again has only its entry's ID: its key finds it, to answer "opening".
    const opening: Copy = {
      id: undefined,
      registered: MIRA,
      state: "opening",
      folder: at("mira-copy"),
    };
    expect(findSpace([original, opening], key)).toBe(opening);
    // A key of another folder, or of another space, reaches nothing.
    expect(findSpace(spaces, copyKey(MIRA, at("elsewhere")))).toBeUndefined();
    expect(findSpace(spaces, copyKey(LIFE, at("mira-copy")))).toBeUndefined();
  });
});
