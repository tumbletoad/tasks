import { join } from "node:path";

// Only fixed arguments reach the shell. The agent exits without loading a language runtime.
export const failingAgentArgv: [string, ...string[]] =
  process.platform === "win32"
    ? [
        join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"),
        "/d",
        "/c",
        "exit",
        "1",
      ]
    : ["/bin/sh", "-c", "exit 1"];
