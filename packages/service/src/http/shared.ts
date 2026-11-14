// What the CLI shares with the UI listener (`@tasks/service/http/shared`): the probe that proves
// the listener before `tasks open` trusts its port, the routes it calls, and the lines a person
// reads about the port. It loads no storage: the CLI never imports storage (A2 3.10.4).
export { PROBE_NONCE, probeProof, verifyProbe } from "./auth.ts";
export { PROBE_PATH, hostsOf, originsOf } from "./checks.ts";
export { blockedMessage, movedMessage } from "./messages.ts";
