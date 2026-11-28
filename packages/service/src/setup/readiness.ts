import { instanceHome, instanceReadiness, type Instance, type Readiness } from "@ttasks/launch";
import { samePath, type HomeView, type SetupInput } from "./agents.ts";

const TARGET = { "claude-code": "claude-cli", codex: "codex-cli" } as const;

/**
 * Each home's readiness (instanceReadiness), in order: the program machine.toml's instance for
 * the home runs, else the one detection found for it. Undefined for no home, or an app without a
 * sign-in to ask about. The status commands run side by side.
 */
export function homesReadiness(
  input: SetupInput,
  homes: readonly (HomeView["home"] | undefined)[],
): Promise<(Readiness | undefined)[]> {
  const { platform, userHome } = input;
  return Promise.all(
    homes.map(async (home) => {
      if (home === undefined || (home.app !== "claude-code" && home.app !== "codex")) {
        return undefined;
      }
      const target = TARGET[home.app];
      const owner = input.instances.find(
        (i) =>
          i.enabled &&
          i.target === target &&
          samePath(platform, instanceHome(i, userHome, platform)?.path ?? "", home.home),
      );
      const found = input.detection.proposals.find(
        (p) =>
          p.target === target &&
          p.configHome !== undefined &&
          samePath(platform, p.configHome, home.home),
      );
      const program: Pick<Instance, "target" | "exec" | "argsPrefix" | "env" | "configHome"> =
        owner ?? {
          target,
          exec: found?.exec,
          argsPrefix: found?.argsPrefix ?? [],
          env: found?.env ?? {},
          configHome: home.home,
        };
      return instanceReadiness(program, {
        platform,
        base: input.env,
        baseKind: input.envKind ?? "user",
        home: userHome,
      });
    }),
  );
}
