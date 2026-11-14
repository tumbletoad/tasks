// What the CLI touches of its process, as one value: the real process in bin.ts, a recording in
// tests. Output for people goes to stdout, diagnostics to stderr (A2 3.10.2).
export interface Io {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  /** Whether stdin and stdout are terminals: the service decides the class from it (A2 3.6.5). */
  readonly tty: { readonly stdin: boolean; readonly stdout: boolean };
  readonly pid: number;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of stdin, as text, read once. */
  readStdin(): Promise<string>;
  /** A file's text (`--input <file>`). */
  readFile(path: string): Promise<string>;
}
