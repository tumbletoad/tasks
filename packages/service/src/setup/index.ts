// @tasks/service/setup: `tasks setup agents` (A3 3.13; M2.14). The CLI runs it in the person's
// session, with the person's environment, and keeps the agent-home rows through the service.
export * from "./agents.ts";
export { parseStrictJson, type StrictJson } from "./json.ts";
export * from "./run.ts";
export * from "./state.ts";
