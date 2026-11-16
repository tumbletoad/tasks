// Signs the archives in dist with a throwaway Ed25519 test key (A2 3.12.4, spike only).
//
//   pnpm exec node spikes/m0/packaging/scripts/sign.ts --throwaway <empty folder outside the repo>
//     [--dist <folder>]
//
// Generates the key with ssh-keygen in the given folder, writes SHA256SUMS, SHA256SUMS.sshsig and
// install-<version>.sh/.ps1 (which pin the throwaway public key), then deletes the key. There is no
// option to use any other key: real releases are signed by the release workflow.
import { mkdirSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultDist } from "../src/paths.ts";
import { deleteKey, generateThrowawayKey, signRelease } from "../src/release.ts";

const { values } = parseArgs({
  options: {
    throwaway: { type: "string" },
    dist: { type: "string", default: defaultDist },
  },
  strict: true,
});
if (values.throwaway === undefined) throw new Error("pass --throwaway <empty temporary folder>");
mkdirSync(values.throwaway, { recursive: true });
if (readdirSync(values.throwaway).length > 0) throw new Error(`${values.throwaway} is not empty`);

const key = generateThrowawayKey(values.throwaway);
try {
  const signed = signRelease(values.dist, key);
  console.log(`throwaway public key: ${key.publicKey}`);
  console.log(`signed: ${signed.sums} -> ${signed.signature}`);
  for (const f of signed.installers) console.log(`install script: ${f}`);
} finally {
  deleteKey(key);
  console.log("throwaway private key deleted");
}
