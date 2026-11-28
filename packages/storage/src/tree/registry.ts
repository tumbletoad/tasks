// Every named command of the tree, by name: the tasks', the Trash's, notes and projects
// (commands.ts), pages and a node's texts (knowledge.ts), sources and links (sources.ts), preferences (prefs.ts), what Open and Run record (runs.ts), and routines (routines.ts).
import { TASK_COMMANDS } from "./commands.ts";
import { KNOWLEDGE } from "./knowledge.ts";
import { PREFS } from "./prefs.ts";
import { ROUTINES } from "./routines.ts";
import { RUNS } from "./runs.ts";
import { SOURCES } from "./sources.ts";
import type { Command } from "./tx.ts";

export const COMMANDS: Readonly<Record<string, Command>> = {
  ...TASK_COMMANDS,
  ...KNOWLEDGE,
  ...SOURCES,
  ...PREFS,
  ...RUNS,
  ...ROUTINES,
};
