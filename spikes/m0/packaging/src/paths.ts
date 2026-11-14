// Locations inside the packaging spike and the repository.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(spikeRoot, "..", "..", "..");

/** The stand-in app: lib/tasks.mjs and the modules it loads. */
export const appDir = join(spikeRoot, "app");
export const posixLauncher = join(spikeRoot, "launcher", "tasks.sh");
export const launcherSource = join(spikeRoot, "launcher", "tasks-launcher.c");
/** The tamper tests' Windows stand-in executable (never shipped). */
export const canarySource = join(spikeRoot, "launcher", "canary-stand-in.c");
export const installTemplates = {
  sh: join(spikeRoot, "install", "install.template.sh"),
  ps1: join(spikeRoot, "install", "install.template.ps1"),
} as const;
export const nodePinFile = join(spikeRoot, "node-pin.json");

/** Default output folder for archives, SHA256SUMS and the rendered install scripts. */
export const defaultDist = join(spikeRoot, "dist");
