// Whether an agent instance can work now: its program is there, in which version, and whether the
// app says it is signed in. The app's own status command (catalogue.ts `signIn`) runs as Open
// runs the app, in the instance's environment and home, with every stream closed: its exit code is
// all that is kept. No sign-in file is opened and no output is read.
import { isBuiltInTarget, targetDef, versionIn, type BuiltInTargetId } from "./catalogue.ts";
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
import { quotedWord, shellLine, shellWord } from "./shell-line.ts";
import { agentEnvironment, type BaseKind } from "./shim/environment.ts";

/** What a person reads of an instance, and the one thing to do next. */
export type Readiness =
  | { readonly state: "not_installed"; readonly install: string }
  | { readonly state: "signed_in"; readonly version: string | undefined }
  | { readonly state: "signed_out"; readonly version: string | undefined; readonly login: string }
  /** The status command is missing, hung, or answered something else: `status` finds out. */
  | { readonly state: "unknown"; readonly version: string | undefined; readonly status: string };

export interface ReadinessOptions {
  readonly platform: NodeJS.Platform;
  /** The environment the agent's starts from, as Open's agents get it. */
  readonly base: Env;
  readonly baseKind?: BaseKind;
  /** The account's home folder. */
  readonly home: string | undefined;
  /** Bound for each command. Default 3 s. */
  readonly timeoutMs?: number;
}

type Checked = Pick<Instance, "target" | "exec" | "argsPrefix" | "env" | "configHome">;

/** An instance's readiness, or undefined for a target without a sign-in to ask about. */
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
    baseKind: options.baseKind ?? "user",
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
  const [out, code] = await Promise.all([
    helperOutput([...argv, "--version"], { env, cwd, deadlineMs, maxChars: 64 * 1024 }),
    exitCode([...argv, ...signIn.status], { env, cwd, deadlineMs }),
  ]);
  const version = out === undefined ? undefined : versionIn(out);
  // The command a person types: the app's bare name when that is the same program, so the line
  // reads as the vendor's own, with the home the instance uses when it is not the app's default.
  const binary = def.detect.binaries[0];
  const named = binary === undefined ? undefined : onPath(host, binary);
  const bare =
    named !== undefined &&
    JSON.stringify(resolveProgram(host, named, [], target)) === JSON.stringify(program);
  const words = bare && binary !== undefined ? [binary] : argv;
  const line = (args: readonly string[]): string =>
    commandLine(platform, [...words, ...args], homeOf(setup.env, target, platform));
  if (code === 0) return { state: "signed_in", version };
  if (code === 1) return { state: "signed_out", version, login: line(signIn.login) };
  return { state: "unknown", version, status: line(signIn.status) };
}

/** The home variable an instance sets, and its value, when it sets one. */
function homeOf(
  env: Readonly<Record<string, string>>,
  target: BuiltInTargetId,
  platform: NodeJS.Platform,
): { readonly name: string; readonly value: string } | undefined {
  const name = targetDef(target).detect.homes?.env;
  const value = name === undefined ? undefined : envValue(env, name, platform);
  return name === undefined || value === undefined ? undefined : { name, value };
}

/** A line to paste: the home's variable first when there is one (shell-line.ts's quoting). */
function commandLine(
  platform: NodeJS.Platform,
  argv: readonly string[],
  home: { readonly name: string; readonly value: string } | undefined,
): string {
  const command = shellLine(platform, argv) ?? argv.join(" ");
  if (home === undefined) return command;
  if (platform === "win32") {
    const value = quotedWord(platform, home.value) ?? `'${home.value}'`;
    return `$env:${home.name} = ${value}; ${command}`;
  }
  return `${home.name}=${shellWord(platform, home.value) ?? `'${home.value}'`} ${command}`;
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
