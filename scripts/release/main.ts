// pnpm release <command>: making, signing, checking and publishing a release.
//
// By hand in a terminal, outside CI (the passphrase is asked without echo):
//   keygen --out <folder outside any checkout>
//   sign --key <key file> --dist <folder> [--expect <.pub file>]
// In the release workflow (.github/workflows/release.yml), which a version tag starts:
//   plan --mode release --tag <v-tag> --run <n> [--repo <owner/name>]
//   plan --mode rehearsal --ref <commit> [--base <commit>] --run <n> [--repo <owner/name>]
//   hold --tag <v-tag> [--repo <owner/name>]
//   gather --from <artifacts folder> --prefix <artifact name prefix> --version <v> --out <new folder>
//   sign-ci --dist <folder>             the release key from the job's secrets RELEASE_KEY and
//                                       RELEASE_KEY_PASSPHRASE, never from an argument or a file
//   rehearse --dist <folder> [--trust-from <commit>]
//   check-install --dist <signed folder> [--from <previous signed folder>] --work <new folder>
//   publish --dist <signed folder> --version <v> --commit <sha> --work <new folder> [--repo <owner/name>]
//
// The secrets are in the environment until takeSecrets runs, which is after every static import
// has run. So this file imports statically only what signing needs, none of it a dependency's code
// (a test holds that); every other command loads its own modules when it runs.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_PUBLIC_KEYS } from "../../packages/service/src/version/release-keys.ts";
import { repoRoot } from "../run.ts";
import {
  ciReleaseSign,
  createReleaseKey,
  MIN_PASSPHRASE,
  redact,
  Refusal,
  refuseInCi,
  rehearsalSign,
  releaseSign,
  takeSecrets,
  type ReleaseSigned,
} from "./release.ts";

const USAGE = [
  "usage: pnpm release keygen --out <folder outside any checkout>",
  "       pnpm release sign --key <release key file> --dist <folder of archives> [--expect <.pub file>]",
  "       pnpm release sign-ci --dist <folder of archives>",
  "       pnpm release rehearse --dist <folder of archives> [--trust-from <commit>]",
  "       pnpm release plan --mode release --tag <v-tag> --run <n> [--repo <owner/name>]",
  "       pnpm release plan --mode rehearsal --ref <commit> [--base <commit>] --run <n> [--repo <owner/name>]",
  "       pnpm release hold --tag <v-tag> [--repo <owner/name>]",
  "       pnpm release gather --from <folder> --prefix <name> --version <v> --out <new folder>",
  "       pnpm release check-install --dist <signed folder> [--from <signed folder>] --work <new folder>",
  "       pnpm release publish --dist <signed folder> --version <v> --commit <sha> --work <new folder> [--repo <owner/name>]",
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

function options<const T extends Record<string, { type: "string" }>>(
  args: readonly string[],
  spec: T,
  required: readonly (keyof T & string)[],
): { [K in keyof T]: string | undefined } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: [...args], options: spec, strict: true }));
  } catch (error) {
    throw new Refusal(`${error instanceof Error ? error.message : String(error)}
${USAGE}`);
  }
  for (const name of required) if (values[name] === undefined) throw new Refusal(USAGE);
  return values as { [K in keyof T]: string | undefined };
}

const str = { type: "string" } as const;

function printSigned(signed: ReleaseSigned): void {
  for (const archive of signed.archives) console.log(`signed: ${archive}`);
  console.log("wrote:  SHA256SUMS, SHA256SUMS.sig, SHA256SUMS.sshsig");
  for (const installer of signed.installers) console.log(`wrote:  ${installer}`);
  console.log(`key:    ${signed.publicKey}`);
  console.log(`        ${signed.fingerprint}`);
}

const repository = (given: string | undefined): string => {
  const repo = given ?? process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Refusal("Pass --repo <owner/name>.");
  }
  return repo;
};

async function main(
  argv: readonly string[],
  secrets: ReturnType<typeof takeSecrets>,
): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => {
    console.log(line);
  };
  switch (command) {
    case "keygen": {
      refuseInCi(process.env);
      const values = options(rest, { out: str }, ["out"]);
      const first = await askHidden(
        `New passphrase (at least ${String(MIN_PASSPHRASE)} characters): `,
      );
      const second = await askHidden("The same passphrase again: ");
      if (first !== second) throw new Refusal("The two passphrases differ. Nothing was written.");
      const created = createReleaseKey(resolve(values.out ?? ""), first, repoRoot);
      console.log(`release key:  ${created.privateKeyFile}`);
      console.log(`public key:   ${created.publicKeyFile}`);
      console.log(`              ${created.publicKey}`);
      console.log(`fingerprint:  ${created.fingerprint}`);
      console.log("Back up the key file and its passphrase apart from each other.");
      return 0;
    }
    case "sign": {
      refuseInCi(process.env);
      const values = options(rest, { key: str, dist: str, expect: str }, ["key", "dist"]);
      printSigned(
        await releaseSign({
          keyFile: resolve(values.key ?? ""),
          dist: resolve(values.dist ?? ""),
          repoRoot,
          passphrase: () => askHidden("Passphrase of the release key: "),
          ...(values.expect === undefined
            ? {}
            : { expect: readFileSync(resolve(values.expect), "utf8") }),
        }),
      );
      return 0;
    }
    case "sign-ci": {
      const values = options(rest, { dist: str }, ["dist"]);
      printSigned(ciReleaseSign({ dist: resolve(values.dist ?? ""), secrets, env: process.env }));
      return 0;
    }
    case "rehearse": {
      const values = options(rest, { dist: str, "trust-from": str }, ["dist"]);
      const from = values["trust-from"];
      const { keysAt } = await import("./plan.ts");
      printSigned(
        rehearsalSign(
          resolve(values.dist ?? ""),
          from === undefined ? RELEASE_PUBLIC_KEYS : keysAt(repoRoot, from),
        ),
      );
      console.log("A rehearsal: no product trusts this key, and nothing here is ever released.");
      return 0;
    }
    case "plan": {
      const values = options(
        rest,
        { mode: str, tag: str, ref: str, base: str, run: str, repo: str },
        ["mode", "run"],
      );
      const run = Number(values.run);
      if (!Number.isSafeInteger(run) || run < 1) throw new Refusal("--run is the run's number.");
      const { packageVersion, planOutputs, planRun } = await import("./plan.ts");
      const { releaseReadiness } = await import("./github.ts");
      const { TRY_AGAIN } = await import("./version.ts");
      let plan: ReturnType<typeof planRun>;
      if (values.mode === "release" && values.tag !== undefined) {
        try {
          plan = planRun({ root: repoRoot, mode: "release", ref: values.tag, run });
        } catch (error) {
          if (error instanceof Refusal) throw new Refusal(`${error.message}\n${TRY_AGAIN}`);
          throw error;
        }
        // Before anything is built or signed.
        const problems = releaseReadiness(repository(values.repo), plan.version);
        if (problems.length > 0) throw new Refusal(problems.join("\n"));
      } else if (values.mode === "rehearsal" && values.ref !== undefined) {
        plan = planRun({
          root: repoRoot,
          mode: "rehearsal",
          ref: values.ref,
          ...(values.base === undefined ? {} : { base: values.base }),
          run,
        });
        // What a tag on this commit would meet, told and not enforced: a pull request does not
        // change the settings, and need not raise the version.
        const repo = values.repo ?? process.env["GITHUB_REPOSITORY"];
        if (repo !== undefined) {
          const version = packageVersion(repoRoot, plan.commit);
          let problems: string[];
          try {
            problems = releaseReadiness(repository(repo), version);
          } catch (error) {
            problems = [error instanceof Error ? error.message : String(error)];
          }
          for (const problem of problems) {
            console.log(`::warning title=A tag v${version} would be refused::${problem}`);
          }
          if (problems.length === 0) console.log(`A tag v${version} on main would be released.`);
        }
        if (plan.freshOnly !== undefined) {
          console.log(`::notice title=Fresh installs only::${plan.freshOnly}`);
        }
      } else {
        throw new Refusal(USAGE);
      }
      const out = planOutputs(plan);
      process.stdout.write(out);
      const file = process.env["GITHUB_OUTPUT"];
      if (file !== undefined && file !== "") appendFileSync(file, out);
      return 0;
    }
    case "gather": {
      const values = options(rest, { from: str, prefix: str, version: str, out: str }, [
        "from",
        "prefix",
        "version",
        "out",
      ]);
      const { gatherArchives } = await import("./gather.ts");
      const names = gatherArchives({
        from: resolve(values.from ?? ""),
        prefix: values.prefix ?? "",
        version: values.version ?? "",
        out: resolve(values.out ?? ""),
      });
      for (const name of names) log(`gathered: ${name}`);
      return 0;
    }
    case "check-install": {
      const values = options(rest, { dist: str, from: str, work: str }, ["dist", "work"]);
      const { installCheck } = await import("./install-check.ts");
      installCheck({
        dist: values.dist ?? "",
        ...(values.from === undefined ? {} : { from: values.from }),
        work: values.work ?? "",
        log,
      });
      log("check-install passed");
      return 0;
    }
    case "hold": {
      const values = options(rest, { tag: str, repo: str }, ["tag"]);
      const { holdRelease } = await import("./github.ts");
      holdRelease({ repo: repository(values.repo), tag: values.tag ?? "", log });
      return 0;
    }
    case "publish": {
      const values = options(rest, { dist: str, version: str, commit: str, work: str, repo: str }, [
        "dist",
        "version",
        "commit",
        "work",
      ]);
      const { publishRelease } = await import("./github.ts");
      publishRelease({
        repo: repository(values.repo),
        dist: resolve(values.dist ?? ""),
        version: values.version ?? "",
        commit: values.commit ?? "",
        work: resolve(values.work ?? ""),
        log,
      });
      return 0;
    }
    default:
      throw new Refusal(USAGE);
  }
}

// First, before anything else runs or starts a process: the secrets leave the environment.
const secrets = takeSecrets(process.env);
try {
  process.exitCode = await main(process.argv.slice(2), secrets);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Refusal || (error instanceof Error && error.name === "VersionRefusal")) {
    console.error(redact(message, secrets));
    process.exitCode = 2;
  } else {
    console.error(`release FAILED: ${redact(message, secrets)}`);
    process.exitCode = 1;
  }
}
