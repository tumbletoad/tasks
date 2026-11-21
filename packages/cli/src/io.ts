// What the CLI touches of its process, as one value: the real process in bin.ts, a recording in
// tests. Output for people goes to stdout, diagnostics to stderr.
import { isAgentMarker } from "@ttasks/bridge/protocol";

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
  /**
   * Asks the person a yes-or-no question on the terminal: the question on stderr, the answer from
   * stdin. Absent when stdin is no terminal, where no one can answer.
   */
  readonly ask?: (question: string) => Promise<boolean>;
  /**
   * What to print on stderr if the person presses Ctrl+C from now on, or undefined for nothing: a
   * write that may already have gone through says how to retry it without doing it twice.
   */
  readonly onInterrupt?: (note: string | undefined) => void;
  /** A file's text (`--input <file>`). */
  readFile(path: string): Promise<string>;
}
