// Where the agent CLIs are, per machine (M0.09). Windows: `claude.exe` on PATH, and Codex as
// `node <npm>\@openai\codex\bin\codex.js` (A4: never a .cmd shim). Linux: the login shell's
// `command -v` (nvm puts node and codex on the login PATH only), run with the login shell's PATH.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface Cli {
  file: string;
  /** Arguments before the CLI's own (Codex on Windows: the codex.js entry). */
  prefix: string[];
}

export interface Clis {
  claude: Cli;
  codex: Cli;
  /** The PATH to give the CLIs (the login shell's on Linux, this process's on Windows). */
  path: string;
}

function onPath(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findClis(): Clis {
  // Self-test only: fake CLIs (`claude.mjs`, `codex.mjs` in that folder) run with this Node.
  const fakes = process.env["TASKS_M0_TEST_CLIS"];
  if (fakes !== undefined && fakes !== "") {
    return {
      claude: { file: process.execPath, prefix: [join(fakes, "claude.mjs")] },
      codex: { file: process.execPath, prefix: [join(fakes, "codex.mjs")] },
      path: process.env["PATH"] ?? process.env["Path"] ?? "",
    };
  }
  if (process.platform === "win32") {
    const path = process.env["PATH"] ?? process.env["Path"] ?? "";
    const claude = onPath("claude.exe", path);
    const node = onPath("node.exe", path);
    const appdata = process.env["APPDATA"] ?? "";
    const entry = join(appdata, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (claude === undefined || node === undefined || !existsSync(entry)) {
      throw new Error("claude.exe, node.exe or the codex.js entry not found");
    }
    return { claude: { file: claude, prefix: [] }, codex: { file: node, prefix: [entry] }, path };
  }
  const marker = "__TASKS_M0_09__";
  const script = `printf '%s\\n' "${marker}" "$(command -v claude)" "$(command -v codex)" "$PATH"`;
  const r = spawnSync("bash", ["-lic", script], { encoding: "utf8", timeout: 30_000 });
  const lines = r.stdout.split("\n");
  const at = lines.indexOf(marker);
  const [claude, codex, path] = [lines[at + 1], lines[at + 2], lines[at + 3]];
  if (at < 0 || claude === undefined || codex === undefined || path === undefined) {
    throw new Error("login shell did not report claude, codex and PATH");
  }
  if (claude === "" || codex === "") throw new Error("claude or codex not on the login PATH");
  return { claude: { file: claude, prefix: [] }, codex: { file: codex, prefix: [] }, path };
}
