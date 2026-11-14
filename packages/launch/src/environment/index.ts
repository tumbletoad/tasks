// The agent's environment on this machine (A4 3.8): the session layer, the login-shell snapshot
// and its store (Linux and macOS), the registry layers (Windows). shim/environment.ts builds the
// agent's environment from the base these give.
export * from "./capture.ts";
export * from "./layers.ts";
export * from "./provider.ts";
