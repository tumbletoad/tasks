// Publishing fixtures (M0.11, N05): every output (streams, inventories, indexes) is built and
// checked inside the run's scratch folder, and only when every file passes are they copied to the
// destination: all or nothing. The copy goes to temporary names first and is renamed in place at
// the end, so a failed copy leaves the destination as it was (the temporary files are removed).
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LabError } from "../agents/facts.ts";
import type { Scratch } from "../agents/scratch.ts";
import {
  checkContent,
  checkIndexStructure,
  checkInventoryStructure,
  checkJsonContent,
  checkStreamFixture,
  type DenyEntry,
} from "../../../tests/stream-content.ts";

export interface Output {
  /** Path below the fixture folder, with forward slashes. */
  rel: string;
  text: string;
}

/** The findings for one output: the content scan and the structure of its kind of file. */
export function checkOutput(o: Output, deny: readonly DenyEntry[]): string[] {
  if (o.rel.endsWith(".jsonl")) return checkStreamFixture(o.rel, o.text, deny);
  let value: unknown;
  try {
    value = JSON.parse(o.text);
  } catch {
    return ["not JSON"];
  }
  const scan = [...checkContent(o.text, deny, true), ...checkJsonContent(value, deny)];
  if (/^fields-(?:windows|linux)\.json$/.test(o.rel)) {
    return [...scan, ...checkInventoryStructure(value)];
  }
  if (/^index-(?:windows|linux)\.json$/.test(o.rel))
    return [...scan, ...checkIndexStructure(value)];
  return ["an output the lab does not publish"];
}

/**
 * Stages every output in a new folder inside the scratch folder, checks the staged files, and
 * copies them to `dest` only when all pass. Findings stay in the stage folder (rule labels and
 * line numbers only); the error says nothing was published.
 */
export function stageAndPublish(
  sc: Scratch,
  outputs: readonly Output[],
  dest: string,
  deny: readonly DenyEntry[],
): { files: number } {
  for (const o of outputs) {
    if (!/^(?:[a-z-]+\/)?[a-z0-9-]+\.jsonl?$/.test(o.rel)) throw new LabError("bad output name");
  }
  const stage = sc.mkdir(join(sc.root, `stage-${randomUUID().slice(0, 8)}`));
  for (const o of outputs) {
    const p = join(stage, o.rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, o.text);
  }
  const failed: { rel: string; findings: string[] }[] = [];
  for (const o of outputs) {
    const findings = checkOutput(
      { rel: o.rel, text: readFileSync(join(stage, o.rel), "utf8") },
      deny,
    );
    if (findings.length > 0) failed.push({ rel: o.rel, findings });
  }
  if (failed.length > 0) {
    writeFileSync(join(stage, "findings.json"), `${JSON.stringify(failed, null, 2)}\n`);
    throw new LabError("content check failed, nothing was published");
  }
  const id = randomUUID().slice(0, 8);
  const temps: string[] = [];
  try {
    for (const o of outputs) {
      const target = join(dest, o.rel);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${id}`;
      temps.push(tmp);
      copyFileSync(join(stage, o.rel), tmp);
    }
  } catch {
    for (const t of temps) rmSync(t, { force: true });
    throw new LabError("copy to the destination failed, nothing was published");
  }
  for (const o of outputs) renameSync(`${join(dest, o.rel)}.tmp-${id}`, join(dest, o.rel));
  sc.remove(stage);
  return { files: outputs.length };
}
