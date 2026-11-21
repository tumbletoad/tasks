// What the CLI shares with the UI listener (`@ttasks/service/http/shared`): the probe that proves
// the listener before `ttasks open` trusts its port, the routes it calls, the lines a person reads
// about the port, and the reader of the page's tags that doctor's self-test shares with the
// service's check of a built page. It loads no storage: the CLI never imports storage (A2 3.10.4).
export { PROBE_NONCE, probeProof, verifyProbe } from "./auth.ts";
export { PROBE_PATH, hostsOf, originsOf } from "./checks.ts";
export { blockedMessage, movedMessage } from "./messages.ts";
export { metaContent, startTags, tagsNamed, type StartTag } from "./tags.ts";
