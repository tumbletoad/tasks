// What an agent instance's app reports about itself: its program is there, in which version, and
// whether its own status command (catalogue.ts `signIn`) found a login for the instance's home. The
// command runs in the environment a launch builds, from the account's home folder and without the
// instance's extra arguments, with every stream closed: its exit code is all that is kept. No
// sign-in file is opened and no output is read. It only informs: a key in the environment or a
// gateway works without a login the command recognises, and a login it found may not work.
import { inTestedRange, isBuiltInTarget, targetDef, versionIn } from "./catalogue.ts";
import {
  agentSetup,
  envValue,
  nodeDetectHost,
  onPath,
  resolveProgram,
  type Env,
} from "./detect.ts";
import { helperOutput, startHelper } from "./helpers.ts";
import type { Instance } from "./sections.ts";
import { MAX_LINE_BYTES, quotedWord, shellLine } from "./shell-line.ts";
import { agentEnvironment, type BaseKind } from "./shim/environment.ts";

/**
 * What a person reads of an instance. `login` and `status` are lines to paste, each changing the
 * home for that one command only; undefined when no line can be quoted safely, or (`status`) the
 * version has no status command or cannot be read.
 */
export type Readiness =
  | { readonly state: "not_installed"; readonly install: string }
  | { readonly state: "login_found"; readonly version: string | undefined }
  | {
      readonly state: "no_login";
      readonly version: string | undefined;
      readonly login: string | undefined;
    }
  /** The status command is too new for this version, hung, or answered neither way. */
  | {
      readonly state: "unknown";
      readonly version: string | undefined;
      readonly status: string | undefined;
    };

export interface ReadinessOptions {
  readonly platform: NodeJS.Platform;
  /** The environment a launch starts from (environment/ `base`), with its kind. */
  readonly base: Env;
  readonly baseKind: BaseKind;
  /** The account's home folder. */
  readonly home: string | undefined;
  /** Bound for each command. Default 3 s. */
  readonly timeoutMs?: number;
}

type Checked = Pick<Instance, "target" | "exec" | "argsPrefix" | "env" | "configHome">;

/** An instance's readiness, or undefined for a target without a login to ask about. */
export async function instanceReadiness(
  instance: Checked,
  options: ReadinessOptions,
): Promise<Readiness | undefined> {
  const { target } = instance;
  if (!isBuiltInTarget(target)) return undefined;
  const def = targetDef(target);
  const signIn = def.signIn;
  if (signIn === undefined) return undefined;
  const { platform, home } = options;
  const setup = agentSetup(instance, home, platform);
  const env = agentEnvironment({
    platform,
    base: options.base,
    baseKind: options.baseKind,
    instance: setup.env,
    ...(setup.ownHome === undefined ? {} : { ownHome: setup.ownHome }),
    additions: {},
    ...(instance.exec === undefined ? {} : { executable: instance.exec }),
  });
  const cwd = home ?? process.cwd();
  const host = nodeDetectHost({ platform, env, home: cwd });
  const program =
    instance.exec === undefined
      ? undefined
      : resolveProgram(host, instance.exec, instance.argsPrefix, target);
  if (program === undefined || !program.ok) {
    return { state: "not_installed", install: signIn.install };
  }
  const argv = [program.command, ...program.args];
  const deadlineMs = options.timeoutMs ?? 3_000;
  const out = await helperOutput([...argv, "--version"], {
    env,
    cwd,
    deadlineMs,
    maxChars: 64 * 1024,
  });
  const version = out === undefined ? undefined : versionIn(out);
  // A version older than the status command would take its words for something else (Claude Code
  // reads them as a prompt): it is not run, and nothing is suggested.
  if (
    signIn.since !== undefined &&
    (version === undefined || inTestedRange(version, `>=${signIn.since}`) !== true)
  ) {
    return { state: "unknown", version, status: undefined };
  }
  const code = await exitCode([...argv, ...signIn.status], { env, cwd, deadlineMs });
  // The command a person types: the app's bare name when that is the same program, so the line
  // reads as the vendor's own.
  const binary = def.detect.binaries[0];
  const named = binary === undefined ? undefined : onPath(host, binary);
  const bare =
    named !== undefined &&
    JSON.stringify(resolveProgram(host, named, [], target)) === JSON.stringify(program);
  const words = bare && binary !== undefined ? [binary] : argv;
  const variable = def.detect.homes?.env;
  const value = variable === undefined ? undefined : envValue(setup.env, variable, platform);
  const line = (args: readonly string[]): string | undefined =>
    variable === undefined
      ? shellLine(platform, [...words, ...args])
      : oneCall(platform, [...words, ...args], variable, value ?? null);
  if (code === 0) return { state: "login_found", version };
  if (code === 1) return { state: "no_login", version, login: line(signIn.login) };
  return { state: "unknown", version, status: line(signIn.status) };
}

/**
 * A line that runs `argv` with the home variable `name` set to `value`, or unset (null), for that
 * one command: the terminal's own setting is left as it was. Undefined when it cannot be quoted.
 */
export function oneCall(
  platform: NodeJS.Platform,
  argv: readonly string[],
  name: string,
  value: string | null,
): string | undefined {
  const command = shellLine(platform, argv);
  if (command === undefined) return undefined;
  let line: string;
  if (platform === "win32") {
    const quoted = value === null ? "$null" : quotedWord(platform, value);
    if (quoted === undefined) return undefined;
    line = `& { $was = $env:${name}; $env:${name} = ${quoted}; try { ${command} } finally { $env:${name} = $was } }`;
  } else if (value === null) {
    line = `env -u ${name} ${command}`;
  } else {
    const quoted = quotedWord(platform, value);
    if (quoted === undefined) return undefined;
    line = `${name}=${quoted} ${command}`;
  }
  return Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES ? line : undefined;
}

/** A program's exit code with every stream closed; undefined when it did not start or end in time. */
async function exitCode(
  argv: readonly string[],
  options: { readonly env: Env; readonly cwd: string; readonly deadlineMs: number },
): Promise<number | undefined> {
  try {
    return (await startHelper(argv, options).ended) ?? undefined;
  } catch {
    return undefined;
  }
}
