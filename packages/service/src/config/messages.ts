// What a person reads when machine.toml stops the service: on stderr when it refuses to start, and
// in `tasks doctor`. The log gets codes only (service.ts).
import { PRODUCT_NAME } from "@tasks/brand";
import type { ConfigProblem } from "@tasks/launch";
import { unsafeMessage } from "../hub/permissions.ts";
import { MACHINE_TOML, type UnsafeConfig } from "./machine-toml.ts";

/**
 * The line a person reads when machine.toml stops the start: each fatal problem's key and code (a
 * syntax error's line and column), never a value. At most five are named.
 */
export function configRefusal(problems: readonly ConfigProblem[]): string {
  const named = problems.slice(0, 5).map((p) => {
    if (p.key === "" && p.line !== undefined) {
      return `${p.code} at line ${String(p.line)}, column ${String(p.column ?? 0)}`;
    }
    return p.key === "" ? p.code : `${p.key} (${p.code})`;
  });
  const more =
    problems.length > named.length ? `, and ${String(problems.length - named.length)} more` : "";
  return `${PRODUCT_NAME}'s ${MACHINE_TOML} has a problem the service cannot start with: ${named.join(", ")}${more}.`;
}

/**
 * The line a person reads when machine.toml or its folder fails the rule (another user could change
 * it, it is a link, or its owner lacks access): which one, what is wrong, why that matters, and the
 * one command that fixes both (A2 3.2.2 rule 5, permissions.ts). It names paths, so it goes to
 * stderr and doctor only, never to the log.
 */
export function unsafeConfigMessage(found: UnsafeConfig, user?: string): string {
  const file = `${PRODUCT_NAME}'s ${MACHINE_TOML}`;
  return unsafeMessage(
    found.map((part) => ({
      name: part.what === "folder" ? `${PRODUCT_NAME}'s configuration folder` : file,
      facts: part.facts,
      problem: part.problem,
      ...(part.hides === true ? { hides: file } : {}),
    })),
    `${PRODUCT_NAME} uses ${MACHINE_TOML} only when no one else can change it, because it names commands ${PRODUCT_NAME} runs as you, so the service does not start`,
    user,
  );
}
