// pnpm gen: regenerates every generated folder (A7 3.3).
import { generators, writeGenerated } from "./generated.ts";
import { repoRoot } from "./run.ts";

await writeGenerated(repoRoot, generators);
console.log(
  generators.length === 0
    ? "gen: no generators registered yet"
    : `gen: ${generators.map((g) => g.dir).join(", ")} written`,
);
