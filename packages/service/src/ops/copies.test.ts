// Which space an ID, a name or a folder means (A2 3.10.5), with one folder serving a space at a
// time: the lookup every caller uses. Fixture folders only.
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ambiguousError, copyOf, findSpace, isAmbiguity, onlySpace, type Copy } from "./copies.ts";

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

describe("[A2.3.10.5.copies.rule] an ID or a name means the folder that serves the space", () => {
  test("the served entry, by ID, by name and as the one space, whatever the order; a folder names its own entry", () => {
    const served = space(MIRA, "mira-copy", "read_only", "read_only_copy");
    const closed = space(MIRA, "mira", "closed");
    for (const spaces of [
      [closed, served],
      [served, closed],
    ]) {
      expect(copyOf(spaces, MIRA)).toBe(served);
      expect(findSpace(spaces, MIRA)).toBe(served);
      expect(findSpace(spaces, "mira")).toBe(served);
      expect(onlySpace(spaces)).toBe(served);
      expect(findSpace(spaces, at("mira"))).toBe(closed);
    }
    // A copy not served yet (its folder gone) has no ID read from its folder, but its entry's ID
    // makes it a copy of the space: still one space.
    const gone: Copy = {
      id: undefined,
      registered: MIRA,
      state: "unavailable",
      reason: "missing",
      folder: at("look"),
    };
    expect(onlySpace([gone, served])).toBe(served);
    expect(onlySpace([gone, space(LIFE, "life", "open")])).toBe("several");
  });

  test("while no entry serves the space, the first one listed answers with its own state", () => {
    const missing = space(MIRA, "mira", "unavailable", "missing");
    const closed = space(MIRA, "mira-copy", "closed");
    expect(copyOf([missing, closed], MIRA)).toBe(missing);
    expect(copyOf([closed, missing], MIRA)).toBe(closed);
    // Opening or closing for a moment is serving: the answer is "retry".
    const opening = space(MIRA, "mira-copy", "opening");
    expect(copyOf([missing, opening], MIRA)).toBe(opening);
    // A copy being opened again (a claim, a restore in place) has no ID read from its folder yet:
    // its entry's ID finds it, beside the original that closed.
    const reopening: Copy = { id: undefined, registered: MIRA, state: "opening", folder: at("c") };
    for (const spaces of [
      [space(MIRA, "mira", "closed"), reopening],
      [reopening, space(MIRA, "mira", "closed")],
    ]) {
      expect(copyOf(spaces, MIRA)).toBe(reopening);
      expect(findSpace(spaces, MIRA)).toBe(reopening);
    }
  });

  test("a name two spaces have is ambiguous, and the ID names one of them", () => {
    const other = space(LIFE, "life", "open", undefined, "Mira");
    const byName = findSpace([space(MIRA, "mira", "open"), other], "Mira");
    expect(isAmbiguity(byName) && byName.ambiguous).toBe("name");
    expect(findSpace([space(MIRA, "mira", "open"), other], LIFE)).toBe(other);
    expect(ambiguousError().code).toBe("ambiguous");
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
