// An Agent Monitor that does not exist, for every service a test starts. Its own module: the setup
// file that runs first in every worker imports it, and must load nothing a test mocks.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NO_MONITOR = join(dirname(fileURLToPath(import.meta.url)), "no-monitor");

/** A T3 Code home that does not exist, for every service a test starts: none reaches the machine's T3. */
export const NO_T3_HOME = join(dirname(fileURLToPath(import.meta.url)), "no-t3-home");
