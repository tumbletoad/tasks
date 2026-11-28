// The contracts generators that scripts/generated.ts registers for `pnpm gen` and the freshness
// step of `pnpm verify`. Both refuse to render a registry that fails the registry check.
import { checkRegistry } from "../check.ts";
import type { AnyEntry } from "../define.ts";
import { registry } from "../registry.ts";
import { renderArtefacts } from "./artefacts.ts";
import { renderDocs, type DocNames } from "./docs.ts";

/** The names the generators take: the CLI's and the MCP server key, which starts no tool name. */
export type GeneratorNames = DocNames;

/** The shape scripts/generated.ts expects. Contracts depend on nothing in the repository. */
export interface ContractsGenerator {
  readonly name: string;
  readonly dir: string;
  render(): Promise<ReadonlyMap<string, string>>;
}

export const CONTRACTS_DIR = "packages/contracts/generated";
export const DOCS_DIR = "docs/agents";

export function contractsGenerators(
  names: GeneratorNames,
  entries: readonly AnyEntry[] = registry,
): ContractsGenerator[] {
  const valid = () => {
    const problems = checkRegistry(entries, { serverKey: names.mcpServerKey });
    if (problems.length > 0) {
      throw new Error(`the registry check failed:\n  ${problems.join("\n  ")}`);
    }
  };
  // A throw inside the executor becomes a rejection, which `pnpm verify` reports as a failed step.
  const checked = (render: () => Map<string, string>) => () =>
    new Promise<ReadonlyMap<string, string>>((resolve) => {
      valid();
      resolve(render());
    });
  return [
    {
      name: "contracts",
      dir: CONTRACTS_DIR,
      render: checked(() => renderArtefacts(entries)),
    },
    {
      name: "agent docs",
      dir: DOCS_DIR,
      render: checked(() => renderDocs(entries, names)),
    },
  ];
}
