// `ttasks doctor`'s monitor row, from the service's `doctor/monitor`: whether the Agent Monitor
// (TTAM) is found as the service would start it, whether its version fits, and what to do when
// not. TTasks works without it, so no answer fails the report.
import { MONITOR_COMMAND, MONITOR_NAME, PRODUCT_NAME } from "@ttasks/brand";
import type { Check } from "./doctor-launch.ts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const named = (build: unknown): string => {
  if (!isObject(build) || typeof build["version"] !== "string") return MONITOR_NAME;
  const commit = typeof build["build"] === "string" ? ` (${build["build"]})` : "";
  return `${MONITOR_NAME} ${build["version"]}${commit}`;
};

export function monitorCheck(answer: unknown): Check {
  const id = "monitor";
  if (!isObject(answer)) return { id, status: "skip", detail: "The service did not answer." };
  if (answer["fits"] === true) {
    return { id, status: "ok", detail: `${named(answer["build"])} is found and fits.` };
  }
  const problem = isObject(answer["problem"]) ? answer["problem"] : {};
  const warn = (detail: string): Check => ({ id, status: "warn", detail });
  switch (problem["kind"]) {
    case "not_installed":
      if (problem["reason"] === "script") {
        return warn(
          `The ${MONITOR_COMMAND} on the PATH is a script, and ${PRODUCT_NAME} runs none. Put the ${MONITOR_COMMAND} program itself on the PATH.`,
        );
      }
      if (problem["reason"] === "no_query") {
        return warn(
          `This ${MONITOR_NAME} has no ${MONITOR_COMMAND} query. Update ${MONITOR_NAME}.`,
        );
      }
      return {
        id,
        status: "skip",
        detail: `${MONITOR_NAME} is not installed. ${PRODUCT_NAME} works without it; with it on the PATH, the Agents page shows every agent on this computer.`,
      };
    case "does_not_fit":
      return warn(
        `${named(problem["found"])} does not fit this ${PRODUCT_NAME}. Update ${problem["update"] === "ttasks" ? PRODUCT_NAME : MONITOR_NAME}.`,
      );
    default:
      return warn(
        `${MONITOR_NAME} did not start as expected (${typeof problem["reason"] === "string" ? problem["reason"] : "unknown"}). Run: ${MONITOR_COMMAND} doctor`,
      );
  }
}
