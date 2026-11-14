// packages/bridge/lib/mcp-offline.json (A2 3.7.3): the offline answers the bridge gives while it
// cannot reach the service, in the source tree. The build (M1.13) puts the same file into each
// version folder as `lib/mcp-offline.json`, and the service writes it to `<cache>` at every start.
// Its content is the service's MCP endpoint's own answers, captured from the same factory
// (packages/service/src/mcp/offline.ts), so the offline tools are the online tools byte for byte.
import { OFFLINE_FILE } from "../packages/bridge/src/mcp/names.ts";

export const BRIDGE_LIB_DIR = "packages/bridge/lib";

/** The generator scripts/generated.ts registers (its `Generator` shape, without importing it). */
export function bridgeOfflineGenerator(): {
  readonly name: string;
  readonly dir: string;
  render(): Promise<ReadonlyMap<string, string>>;
} {
  return {
    name: "bridge offline answers",
    dir: BRIDGE_LIB_DIR,
    render: async () => {
      // Loaded on first use: the endpoint reads contracts' generated tool list when it loads,
      // and `pnpm gen` writes that list (the generator before this one) first.
      const { offlineFileText } = await import("../packages/service/src/mcp/offline.ts");
      return new Map([[OFFLINE_FILE, await offlineFileText()]]);
    },
  };
}
