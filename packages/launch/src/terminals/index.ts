// Terminals: command lines per adapter, the scope wrapper, detection of the
// chain, and the acceptance rule of each adapter. The service starts a terminal launch through
// TerminalLauncher; tests replace its spawner and record the argv.
export * from "./accept.ts";
export * from "./commands.ts";
export * from "./detect.ts";
export * from "./launcher.ts";
export * from "./windows-default.ts";
