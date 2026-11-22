// The updater killed at each journal step from the switch on, with real builds: kills.ts.
import { FROM_SWITCH, killRounds } from "./kills.ts";

killRounds("updater", FROM_SWITCH);
