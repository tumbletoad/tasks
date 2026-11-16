// What the CLI touches of its process, as one value: the real process in bin.ts, a recording in
// tests. Output for people goes to stdout, diagnostics to stderr.
import { isAgentMarker } from "@tasks/bridge/protocol";

/**
 * Whether a person runs this command, as the service will class the connection: no agent marker in
 * the environment, and a terminal on at least one standard stream.
 */
export function personAtTerminal(io: Pick<Io, "env" | "tty">): boolean {
  const agent = Object.entries(io.env).some(([n, v]) => v !== undefined && isAgentMarker(n));
  return !agent && (io.tty.stdin || io.tty.stdout || io.tty.stderr);
}

export interface Io {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  /**
   * Which standard streams are terminals. The service decides the connection's class from it: a
   * person when any one is, so output piped or redirected still counts as theirs.
   */
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
  readonly pid: number;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of stdin, as text, read once. */
  readStdin(): Promise<string>;
  /** A file's text (`--input <file>`). */
  readFile(path: string): Promise<string>;
}
