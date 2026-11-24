// A change of the space's effort levels as Settings makes it: the list to write and the moves that
// carry its tasks along. The rules are the contracts' (EFFORT_KEY, checkEffortMoves), so the grid
// refuses nothing the writer takes.
import {
  EFFORT_KEY,
  effortNamesFit,
  samePrefValue,
  type EffortHeld,
  type EffortLevel,
  type EffortTime,
} from "@ttasks/contracts/preferences";

export interface Move {
  readonly from: string;
  readonly to: string | null;
}

/** One change a person makes in the grid. `at` is the level's place, smallest first. */
export type LevelEdit =
  | { readonly kind: "add"; readonly name: string }
  | { readonly kind: "rename"; readonly at: number; readonly name: string }
  | { readonly kind: "time"; readonly at: number; readonly time: EffortTime | undefined }
  | { readonly kind: "about"; readonly at: number; readonly about: string | undefined }
  | { readonly kind: "up" | "down"; readonly at: number }
  | { readonly kind: "remove"; readonly at: number; readonly to?: string | null };

export interface LevelsWrite {
  readonly value: EffortLevel[];
  readonly moves: Move[];
}

const levelOf = (
  key: string,
  time: EffortTime | undefined,
  about: string | undefined,
): EffortLevel => ({
  key,
  ...(time === undefined ? {} : { time }),
  ...(about === undefined ? {} : { about }),
});

/**
 * The write `edit` makes of `levels`: undefined when it changes nothing. A rename moves the tasks
 * on the old name to the new one, and a removal moves them where the person chose, if anywhere.
 */
export function levelsWrite(
  levels: readonly EffortLevel[],
  edit: LevelEdit,
): LevelsWrite | undefined {
  if (edit.kind === "add") return { value: [...levels, { key: edit.name }], moves: [] };
  const level = levels[edit.at];
  if (level === undefined) return undefined;
  const value = [...levels];
  switch (edit.kind) {
    case "rename":
      if (edit.name === level.key) return undefined;
      value[edit.at] = { ...level, key: edit.name };
      return { value, moves: [{ from: level.key, to: edit.name }] };
    case "time":
      value[edit.at] = levelOf(level.key, edit.time, level.about);
      break;
    case "about":
      value[edit.at] = levelOf(level.key, level.time, edit.about);
      break;
    case "up":
    case "down": {
      const to = edit.at + (edit.kind === "up" ? -1 : 1);
      const other = levels[to];
      if (other === undefined) return undefined;
      value[to] = level;
      value[edit.at] = other;
      return { value, moves: [] };
    }
    case "remove":
      if (levels.length === 1) return undefined;
      value.splice(edit.at, 1);
      return { value, moves: edit.to === undefined ? [] : [{ from: level.key, to: edit.to }] };
  }
  return samePrefValue(value[edit.at], level) ? undefined : { value, moves: [] };
}

export type NameProblem = "empty" | "characters" | "taken" | "long";

/** What keeps `name` from being the name of the level at `at` (levels.length: a new one). */
export function nameProblem(
  levels: readonly EffortLevel[],
  at: number,
  name: string,
): NameProblem | undefined {
  if (name === "") return "empty";
  if (!EFFORT_KEY.test(name)) return "characters";
  const folded = name.toLowerCase();
  if (levels.some((level, i) => i !== at && level.key.toLowerCase() === folded)) return "taken";
  if (
    !effortNamesFit(
      [name],
      levels.map((level) => level.key),
    )
  )
    return "long";
  return undefined;
}

/** How many tasks hold `effort`, in every state. */
export function heldBy(held: readonly EffortHeld[], effort: string): EffortHeld {
  return held.find((h) => h.effort === effort) ?? { effort, active: 0, finished: 0, trash: 0 };
}

export const heldCount = ({ active, finished, trash }: EffortHeld): number =>
  active + finished + trash;

/** Where the tasks of a removed level go unless the person says otherwise: the next bigger level. */
export function moveTarget(levels: readonly EffortLevel[], at: number): string | null {
  return levels[at + 1]?.key ?? levels[at - 1]?.key ?? null;
}

/** A line as a level keeps it: one line in NFC, no control characters, nothing around it. */
export const oneLine = (text: string): string =>
  text
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();
