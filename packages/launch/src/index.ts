// @tasks/launch: target catalogue, instances, routes, terminals, the shim's server side, the launch
// state machine, the environment builder, the URL opener and the T3 client (A7 3.2, A4 3.2–3.10).
// M2.05 brought the launch records: the execution store interface and its v1 backend on the space
// database, and A4's state machine with its external steps injected. M2.06 brought the target
// catalogue, the machine-local sections A4 owns, instance detection and the approval of
// definitions that arrive with data. Routes, terminals and the shim's server side join in M2.08
// to M2.11. M2.11 brought the T3 client and its primary route: pairing (OAuth with PKCE), the T3
// state in machine state, exact-folder binding and the idle-thread launch under a grant. M2.10
// brought the brief and its sanitiser, the CLI routes' command lines, the `claude-cli://` link,
// the OS's URL opener and Codex's reference match. Launch
// code changes a space only through operations sent to its writer: it never imports storage
// (A7 3.2).
export * from "./approval.ts";
export * from "./catalogue.ts";
export * from "./clipboard.ts";
export * from "./detect.ts";
export * from "./git-remote.ts";
export * from "./intents.ts";
export * from "./helpers.ts";
export * from "./machine.ts";
export * from "./places.ts";
export * from "./problems.ts";
export * from "./sections.ts";
export * from "./shell-line.ts";
export * from "./space-store.ts";
export * from "./store.ts";
export * from "./process.ts";
export * from "./requests.ts";
export * from "./shim/index.ts";
export * from "./terminals/index.ts";
export * from "./environment/index.ts";
export * from "./windows-reads.ts";
export * from "./t3-binding.ts";
export * from "./t3-cli.ts";
export * from "./t3-client.ts";
export * from "./t3-oauth.ts";
export * from "./t3-route.ts";
export * from "./t3-state.ts";
export * from "./brief/index.ts";
export * from "./routes/index.ts";
export * from "./opener.ts";
