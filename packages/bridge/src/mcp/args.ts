// `ttasks mcp --space <space-id> [--instance <id>] [--app <name>]`. Setup
// writes these arguments. None of them is a secret, and each is optional: without `--space` the
// service pins the machine default space at bind time.

export interface McpArgs {
  readonly space: string | null;
  readonly instance: string | null;
  readonly app: string | null;
}

export const USAGE = "usage: mcp [--space <space-id>] [--instance <id>] [--app <name>]";

/** An argument value: a short plain identifier, never a path or free text. */
const VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const FLAGS = { "--space": "space", "--instance": "instance", "--app": "app" } as const;
type Flag = keyof typeof FLAGS;
const isFlag = (text: string): text is Flag => Object.hasOwn(FLAGS, text);

/**
 * The arguments, or a usage problem. `--name value` and `--name=value` both work. An unknown
 * argument, a repeated flag or a value that is not a plain identifier is a problem: setup wrote
 * the entry, so a wrong one should fail loudly rather than bind somewhere unexpected.
 */
export function parseArgs(argv: readonly string[]): McpArgs | { readonly problem: string } {
  const found: { space: string | null; instance: string | null; app: string | null } = {
    space: null,
    instance: null,
    app: null,
  };
  const seen = new Set<Flag>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!isFlag(name)) return { problem: "unknown argument" };
    if (seen.has(name)) return { problem: `${name} given twice` };
    seen.add(name);
    let value: string | undefined;
    if (equals === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = arg.slice(equals + 1);
    }
    if (value === undefined || !VALUE.test(value))
      return { problem: `${name} needs a plain value` };
    found[FLAGS[name]] = value;
  }
  return found;
}
