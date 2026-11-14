// pnpm release keygen --out <folder>
// pnpm release sign --key <file> --dist <folder> [--expect <public key file>]
//
// The release script (A2 3.12.8 "sign", A7 3.8 M1.13). It runs by hand on the owner's machine, in a
// terminal: it asks for the key's passphrase without echo. `keygen` makes the release key once
// (A2 3.12.5); `sign` writes SHA256SUMS over the release archives in a
// folder and signs it in both formats. It refuses CI, a key inside a checkout, a test-signed
// folder and more (release.ts). It never prints the private key.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoRoot } from "../run.ts";
import { createReleaseKey, MIN_PASSPHRASE, Refusal, refuseInCi, releaseSign } from "./release.ts";

const USAGE = [
  "usage: pnpm release keygen --out <folder outside any checkout>",
  "       pnpm release sign --key <release key file> --dist <folder of archives> [--expect <.pub file>]",
].join("\n");

/** Reads one line from the terminal without echoing it. Ctrl+C ends the script with nothing done. */
function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new Refusal("Run this in a terminal: it asks for the key's passphrase."));
  }
  process.stderr.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let text = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      if (error === undefined) resolvePromise(text);
      else reject(error);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done();
          return;
        }
        if (char === "\u0003") {
          done(new Refusal("Stopped. Nothing was written."));
          return;
        }
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else if (char >= " ") text += char;
      }
    };
    input.on("data", onData);
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  refuseInCi(process.env);
  if (command === "keygen") {
    const { values } = parseArgs({
      args: rest,
      options: { out: { type: "string" } },
      strict: true,
    });
    if (values.out === undefined) throw new Refusal(USAGE);
    const first = await askHidden(
      `New passphrase (at least ${String(MIN_PASSPHRASE)} characters): `,
    );
    const second = await askHidden("The same passphrase again: ");
    if (first !== second) throw new Refusal("The two passphrases differ. Nothing was written.");
    const created = createReleaseKey(resolve(values.out), first, repoRoot);
    console.log(`release key:  ${created.privateKeyFile}`);
    console.log(`public key:   ${created.publicKeyFile}`);
    console.log(`              ${created.publicKey}`);
    console.log(`fingerprint:  ${created.fingerprint}`);
    console.log("Back up the key file and its passphrase apart from each other.");
    return 0;
  }
  if (command === "sign") {
    const { values } = parseArgs({
      args: rest,
      options: { key: { type: "string" }, dist: { type: "string" }, expect: { type: "string" } },
      strict: true,
    });
    if (values.key === undefined || values.dist === undefined) throw new Refusal(USAGE);
    const signed = await releaseSign({
      keyFile: resolve(values.key),
      dist: resolve(values.dist),
      repoRoot,
      passphrase: () => askHidden("Passphrase of the release key: "),
      ...(values.expect === undefined
        ? {}
        : { expect: readFileSync(resolve(values.expect), "utf8") }),
    });
    for (const archive of signed.archives) console.log(`signed: ${archive}`);
    console.log("wrote:  SHA256SUMS, SHA256SUMS.sig, SHA256SUMS.sshsig");
    for (const installer of signed.installers) console.log(`wrote:  ${installer}`);
    console.log(`key:    ${signed.publicKey}`);
    console.log(`        ${signed.fingerprint}`);
    return 0;
  }
  throw new Refusal(USAGE);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(`release FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
