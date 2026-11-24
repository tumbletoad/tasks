// Who the Trash's heading names for an agent's change, from the label the service writes the
// change under: the app's name the page knows, also for an agent TTasks started, whose label holds
// its session.
import { describe, expect, test } from "vitest";
import { sessionPrincipal } from "../../service/src/ops/caller.ts";
import { agentName } from "../src/views/trash.ts";

describe("[A5.trash.web.names] an agent's change in the Trash is headed by its app's name", () => {
  test("an agent TTasks started, one that named its instance, an instance the page does not list, and one that said nothing", () => {
    const instances = [{ key: "claude-code", label: "Claude Code", glyph: "C", ring: 0 }];
    const bound = sessionPrincipal(
      {
        session: "se_fixture",
        space: "sp_fixture",
        task: "t_fixture",
        home: { of: "launch", app: "claude-code", home: undefined },
      } as Parameters<typeof sessionPrincipal>[0],
      "claude-code",
      "mcp",
    );
    expect(agentName(bound.label, instances)).toBe("Claude Code");
    expect(agentName("agent:claude-code", instances)).toBe("Claude Code");
    expect(agentName("agent:codex-work", instances)).toBe("codex-work");
    expect(agentName("agent:unknown", instances)).toBeUndefined();
  });
});
