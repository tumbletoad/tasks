// An agent's name as the Trash heads its change: the app's name the page knows, from the label the
// service wrote the change under. It imports nothing, so a test that runs without a page can read it.

/**
 * The name for `by` (`agent:<instance>`, or `agent:<instance>:<session>` for one TTasks started),
 * or undefined for an agent that did not say which it is.
 */
export function agentName(
  by: string,
  instances: readonly { readonly key: string; readonly label: string }[],
): string | undefined {
  const key = by.replace(/^agent:/u, "").split(":")[0] ?? "";
  if (key === "" || key === "unknown") return undefined;
  return instances.find((instance) => instance.key === key)?.label ?? key;
}
