// Every named command of the tree, by name: the tasks', the Trash's, notes and projects
// (commands.ts), pages and a node's texts (knowledge.ts), sources and links (sources.ts), and preferences (prefs.ts).
import { TASK_COMMANDS } from "./commands.ts";
import { KNOWLEDGE } from "./knowledge.ts";
import { PREFS } from "./prefs.ts";
import { SOURCES } from "./sources.ts";
import type { Command } from "./tx.ts";

export const COMMANDS: Readonly<Record<string, Command>> = {
  ...TASK_COMMANDS,
  ...KNOWLEDGE,
  ...SOURCES,
  ...PREFS,
};
