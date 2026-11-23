// An Agent Monitor that does not exist, for every service a test starts. Its own module: the setup
// file that runs first in every worker imports it, and must load nothing a test mocks.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NO_MONITOR = join(dirname(fileURLToPath(import.meta.url)), "no-monitor");
