// The CLI's help (A2 3.10.1): the list of commands, and the help of each one. Every command of
// the table below and every generated verb of `cli-spec.json` has its own help, which says what it
// does in one line, its forms and its flags. `ttasks help <command>` and `ttasks <command> --help`
// print the same text. A test walks both tables (help.test.ts).
//
// The table also says which words a command takes first (`subcommands`). A hint that names a
// command is checked against it (hints.test.ts), so no message sends a person to a command that
// does not exist.
import { CLI_NAME } from "@ttasks/brand";
import { CLI_SPEC, takesFolder, verbSpec, type VerbSpec } from "./args.ts";
import { ROOTS_HELP } from "./roots.ts";
import { SERVICE_HELP } from "./service.ts";
import { SETUP_HELP } from "./setup.ts";
import { SPACE_HELP } from "./space.ts";
import { RUN_HELP } from "./runs.ts";
import { VIEW_HELP } from "./view.ts";

export interface LocalCommand {
  readonly name: string;
  /** One line for the list of commands. */
  readonly summary: string;
  /** Its own help: the forms, the flags, what it does. */
  readonly help: string;
  /** The words it takes first, when it takes one: `ttasks service start`. */
  readonly subcommands?: readonly string[];
}

const OPEN_HELP = `Usage: ${CLI_NAME} open [--space <id or name>] [--task <ref>] [--print-url]

Opens the UI in the browser, signed in. Starts the service first when it is not running.

  --space <id or name>  The space to show
  --task <ref>          The task to show (M-14)
  --print-url           Print the link instead of opening it. It holds a one-time sign-in code.
`;

const DOCTOR_HELP = `Usage: ${CLI_NAME} doctor [--live] [--self-test] [--json]

Checks the install, the service, its spaces and the agent apps, and names the command that fixes
what it finds. It works without a running service: that is one of the things it reports.

  --live       Also try each agent app's connection now
  --self-test  Also run the checks an update runs on a new version (from an installed version)
  --json       Print the checks as JSON
`;

const INSTALL_HELP = `Usage: ${CLI_NAME} install --finish [--created <path>]...

Finishes an install. The install scripts run it through the new version's own launcher: it
checks the version and switches to it. A person does not run it.
`;

const UPDATE_HELP = `Usage: ${CLI_NAME} update --from <archive> [--yes] [--stop-runs]
       ${CLI_NAME} update --rollback [--yes] [--stop-runs]
       ${CLI_NAME} update --repair [--stop-runs]

Updates this install from a signed release archive, goes back to the version before the last
update, or finishes an update that was cut off. It restarts the service, and asks once in a
terminal before it does. The restart ends background runs, so new runs wait meanwhile and the
update waits up to 15 minutes for the running ones; then it asks whether to stop them or give
the update up.

  --from <archive>  The release archive to update from
  --rollback        Go back to the version before the last update
  --repair          Finish an update that was cut off
  --yes             Restart the service without asking (for a script)
  --stop-runs       Stop runs still running after the wait without asking (for a script)
`;

const SERVE_HELP = `Usage: ${CLI_NAME} serve

Runs the service in this process. The OS's service manager runs it: to start the service yourself,
run ${CLI_NAME} service start.
`;

const VERSION_HELP = `Usage: ${CLI_NAME} version

Prints this command's version and build. ${CLI_NAME} --version does the same.
`;

const MCP_HELP = `Usage: ${CLI_NAME} mcp [--space <space-id>] [--instance <id>] [--app <name>]

Connects an agent app to the service over stdio: the MCP server entry that ${CLI_NAME} setup agents
writes runs it. A person does not run it.

  --space <space-id>  The space the connection is pinned to; without it, the default space
  --instance <id>     The agent instance the entry belongs to
  --app <name>        The agent app
`;

const RECOVER_HELP = `Usage: ${CLI_NAME} recover [<space>]

Plays back a space's rollback journal: the same command as ${CLI_NAME} space recover. <space> is an
ID, a name or a folder; without one, --space, else the one space the service serves.
Only the user can run this, in an interactive terminal.
`;

const HELP_HELP = `Usage: ${CLI_NAME} help [<command>]

Shows the commands, or the help of one command. ${CLI_NAME} <command> --help shows the same.
`;

/** The commands besides the generated verbs, in the order the list shows them. */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  {
    name: "open",
    summary: "Open the UI in the browser (--space, --task, --print-url)",
    help: OPEN_HELP,
  },
  {
    name: "service",
    summary: "Install, uninstall, start, stop, restart or show the service, or move the UI's port",
    help: SERVICE_HELP,
    subcommands: ["install", "uninstall", "start", "stop", "restart", "status", "port"],
  },
  {
    name: "space",
    summary: "List, create, open, close, forget, back up, restore, claim and recover spaces",
    help: SPACE_HELP,
    subcommands: [
      "list",
      "create",
      "open",
      "close",
      "forget",
      "backup",
      "backups",
      "export",
      "restore",
      "rescue",
      "claim",
      "recover",
      "use",
    ],
  },
  {
    name: "recover",
    summary: "Play back a space's rollback journal: the same as ttasks space recover",
    help: RECOVER_HELP,
  },
  {
    name: "roots",
    summary: "Retired: a task opens in its own folder or its project's",
    help: ROOTS_HELP,
  },
  {
    name: "run",
    summary:
      "Start a background run of a task with an agent, list runs, show a run's answer, stop a run",
    help: RUN_HELP,
    subcommands: ["list", "show", "stop"],
  },
  {
    name: "view",
    summary: "Check a space's generated view/ and render it again (view rebuild)",
    help: VIEW_HELP,
    subcommands: ["rebuild"],
  },
  {
    name: "setup",
    summary:
      "Connect this machine's agent apps: Open's instances (setup instances), their MCP entries (setup agents), T3 Code (setup t3)",
    help: SETUP_HELP,
    subcommands: ["agents", "instances", "t3"],
  },
  {
    name: "mcp",
    summary: "Connect an agent app to the service over stdio (its MCP server entry runs this)",
    help: MCP_HELP,
  },
  {
    name: "doctor",
    summary: "Check the install, the service and the agent apps (--self-test, --live, --json)",
    help: DOCTOR_HELP,
  },
  {
    name: "install",
    summary: "Finish an install: the install scripts run ttasks install --finish",
    help: INSTALL_HELP,
  },
  {
    name: "update",
    summary: "Update from a signed release archive (--from <archive>), --rollback or --repair",
    help: UPDATE_HELP,
  },
  { name: "serve", summary: "Run the service (for service managers)", help: SERVE_HELP },
  { name: "version", summary: "Print this CLI's version", help: VERSION_HELP },
  { name: "help", summary: "Show help, or help for one command", help: HELP_HELP },
];

export const localCommand = (name: string): LocalCommand | undefined =>
  LOCAL_COMMANDS.find((c) => c.name === name);

/** The list of every command, one line each. */
export function shortHelp(): string {
  const width = Math.max(
    ...CLI_SPEC.verbs.map((v) => v.verb.length),
    ...LOCAL_COMMANDS.map((c) => c.name.length),
  );
  const lines = [
    `Usage: ${CLI_NAME} <command> [arguments] [--json] [--space <id or name>] [--request-id <id>]`,
    "",
  ];
  for (const verb of [...CLI_SPEC.verbs].sort((a, b) => a.verb.localeCompare(b.verb))) {
    lines.push(`  ${verb.verb.padEnd(width)}  ${verb.summary}`);
  }
  lines.push("");
  for (const c of LOCAL_COMMANDS) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  lines.push("", `${CLI_NAME} help <command> shows the help of one command.`);
  return `${lines.join("\n")}\n`;
}

/** A flag's placeholder in a usage line: `--reason <reason>`, or the flag alone for a switch. */
const withValue = (flag: VerbSpec["flags"][number]): string =>
  flag.type === "boolean" ? flag.flag : `${flag.flag} <${flag.flag.replace(/^--/, "")}>`;

/**
 * A generated verb's help, from `cli-spec.json` alone: its usage with the required arguments and
 * flags, its summary, and a line per argument. A flag the entry's schema requires is marked
 * `(required)`, so the help and the contract cannot disagree.
 */
export function verbHelp(verb: VerbSpec): string {
  const required = verb.flags.filter((f) => f.required);
  const usage = [
    `${CLI_NAME} ${verb.verb}`,
    ...verb.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)),
    ...required.map(withValue),
    ...(verb.keyValue === undefined ? [] : ["[key=value ...]"]),
    "[options]",
  ].join(" ");
  const lines = [`Usage: ${usage}`, "", verb.summary, ""];
  for (const p of verb.positionals) lines.push(`  <${p.name}>  ${p.help}`);
  for (const k of verb.keyValue?.keys ?? []) lines.push(`  ${k.key}=  ${k.help}`);
  for (const f of verb.flags) {
    const values = f.values === undefined ? "" : ` (${f.values.map(String).join(", ")})`;
    lines.push(
      `  ${f.short === undefined ? "" : `${f.short}, `}${withValue(f)}${f.repeat ? " (repeatable)" : ""}  ${f.help}${values}${f.required ? " (required)" : ""}`,
    );
  }
  // `ttasks brief --copy` is the CLI's own: the OS's clipboard tool, else the text printed.
  if (verb.entry === "launch.open") {
    lines.push("  --copy  Put the text on the clipboard instead of printing it");
  }
  // `--here` and `--create` are the CLI's own: the working folder, and making a folder first.
  if (takesFolder(verb)) {
    lines.push(
      "  --here  The folder you are in, as --folder",
      "  --create  Make the folder first when it is not there",
    );
  }
  // `ttasks undo --yes` is the CLI's own: no question when a script's change is newer than yours.
  if (verb.entry === "history.undo") {
    lines.push(
      "  -y, --yes  Undo your newest change also when a script changed something after it, without asking",
    );
  }
  lines.push(
    "  --input <file or ->  The whole input as JSON",
    "  --json  Print the result as JSON",
  );
  if (verb.actors === "user") lines.push("", "Only the user can run this, from a terminal.");
  return `${lines.join("\n")}\n`;
}

/** The help of one command, or the list when the topic is none or no command. */
export function helpText(topic: string | undefined): string {
  if (topic === undefined) return shortHelp();
  const local = localCommand(topic);
  if (local !== undefined) return local.help;
  const verb = verbSpec(topic);
  return verb === undefined ? shortHelp() : verbHelp(verb);
}
