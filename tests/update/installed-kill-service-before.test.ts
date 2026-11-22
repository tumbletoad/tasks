// The service killed at each journal step before the switch, with real builds: kills.ts.
import { BEFORE_SWITCH, killRounds } from "./kills.ts";

killRounds("service", BEFORE_SWITCH);
