// The Windows facts run of the synced-folder check (A1 3.2, sync-host.ts): how often it runs, and,
// on Windows, the real script through the real Windows PowerShell. The real run reads this
// machine's drives and sync-client keys; the test looks only at the drive that holds the system
// folder and prints nothing it read.
import { win32 } from "node:path";
import { REGISTRY_READS } from "@tasks/launch";
import { describe, expect, test } from "vitest";
import { system32 } from "../src/hub/identity.ts";
import type { WindowsSyncFacts } from "../src/hub/sync-folders.ts";
import {
  parseWindowsFacts,
  readWindowsFacts,
  runWindowsScript,
  WINDOWS_SCRIPT,
  windowsFactsOnce,
} from "../src/hub/sync-host.ts";
import { NO_WINDOWS } from "./sync-fixtures.ts";

/**
 * The real runs' bound in these tests. The product's is 10 s, but these tests are about what the
 * script writes, not how fast PowerShell starts while other tests load the machine.
 */
const RUN_BOUND_MS = 60_000;

/** A run that answers each call with the next of `answers`, and counts its calls. */
function runs(answers: (WindowsSyncFacts | undefined)[]): {
  read: () => Promise<WindowsSyncFacts | undefined>;
  calls: () => number;
} {
  let calls = 0;
  return {
    read: () => {
      calls += 1;
      return Promise.resolve(answers.shift());
    },
    calls: () => calls,
  };
}

describe("[A1.5.sync.windows-facts] the Windows facts run: .NET only, shared while it answers, run again after a failure", () => {
  test("checks that start together share one run, and an answer is kept for a minute", async () => {
    let now = 0;
    const run = runs([NO_WINDOWS, NO_WINDOWS]);
    const facts = windowsFactsOnce(run.read, () => now);
    const [a, b] = await Promise.all([facts(), facts()]);
    expect([a, b, run.calls()]).toEqual([NO_WINDOWS, NO_WINDOWS, 1]);
    now = 59_999;
    await facts();
    expect(run.calls()).toBe(1);
    now = 60_000;
    await facts();
    expect(run.calls()).toBe(2);
  });

  test("a run that gave no facts is not kept: the next check runs again at once", async () => {
    const run = runs([undefined, NO_WINDOWS]);
    const facts = windowsFactsOnce(run.read, () => 0);
    expect(await facts()).toBeUndefined();
    expect(await facts()).toEqual(NO_WINDOWS);
    expect(run.calls()).toBe(2);
    // The answer that came is kept.
    await facts();
    expect(run.calls()).toBe(2);
  });

  test("a run that rejected is not kept either, and its failure reaches only its callers", async () => {
    let calls = 0;
    const facts = windowsFactsOnce(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("probe")) : Promise.resolve(NO_WINDOWS);
      },
      () => 0,
    );
    await expect(facts()).rejects.toThrow("probe");
    expect(await facts()).toEqual(NO_WINDOWS);
    expect(calls).toBe(2);
  });

  test("a check that asks for a fresh run gets one within the minute, and its answer is kept", async () => {
    const one = { ...NO_WINDOWS, drives: [{ root: "C:\\", type: "Fixed", format: "", label: "" }] };
    const run = runs([NO_WINDOWS, one]);
    const facts = windowsFactsOnce(run.read, () => 0);
    expect(await facts()).toEqual(NO_WINDOWS);
    expect(await facts(true)).toEqual(one);
    expect(await facts()).toEqual(one);
    expect(run.calls()).toBe(2);
  });

  test("the script calls no cmdlet: Windows PowerShell never searches its module path for one", () => {
    // Every command word of the script: a cmdlet's is Verb-Noun.
    expect(WINDOWS_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
    expect(WINDOWS_SCRIPT).not.toMatch(/\|/);
  });

  test("the script reads no .NET property but through its accessor: PowerShell 5.1 turns a getter's exception into $null", () => {
    // Type literals (`[IO.DriveInfo]`, `[char]`) aside, every `.Name` is a call: `.Name(`.
    const code = WINDOWS_SCRIPT.replace(/\[[A-Za-z][\w.]*(?:\[\])?\]/g, "");
    expect(code).not.toMatch(/[\w)\]]\.[A-Za-z_]\w*(?![\w(])/);
  });

  // The reads both helper scripts share (@tasks/launch windows-reads.ts), on fake keys that answer
  // the methods the reads call: no registry is read or written.
  test.runIf(process.platform === "win32")(
    "Windows: the registry reads take absence only from a listing, and a listed key or value that reads as nothing throws",
    { timeout: RUN_BOUND_MS + 30_000 },
    async () => {
      const script = [
        "$ErrorActionPreference='Stop'",
        REGISTRY_READS,
        "function m($o,$n,$b){$o.PSObject.Methods.Add([Management.Automation.PSScriptMethod]::new($n,$b))}",
        "function fake($values,$kind,$value,$subs,$opened){$k=[psobject]::new();m $k 'GetValueNames' ({,@($values)}.GetNewClosure());m $k 'GetValueKind' ({param($n) $kind}.GetNewClosure());m $k 'GetValue' ({param($n) ,$value}.GetNewClosure());m $k 'GetSubKeyNames' ({,@($subs)}.GetNewClosure());m $k 'OpenSubKey' ({param($n) $opened}.GetNewClosure());$k}",
        "$bad=[psobject]::new();m $bad 'GetSubKeyNames' {throw 'listing'};m $bad 'GetValueNames' {throw 'listing'}",
        "function case($name,$b){try{$r=& $b;if($null -eq $r){[Console]::Out.WriteLine($name+': null')}else{[Console]::Out.WriteLine($name+': '+$r.GetType().Name+' '+[string]$r)}}catch{[Console]::Out.WriteLine($name+': threw')}}",
        "case 'absent value' {val (fake @() 'String' 'x' @() $null) 'A' @('String')}",
        "case 'value' {val (fake @('A') 'String' 'x' @() $null) 'A' @('String')}",
        "case 'bytes' {val (fake @('A') 'Binary' ([byte[]](1,2)) @() $null) 'A' @('Binary')}",
        "case 'listed value read as nothing' {val (fake @('A') 'String' $null @() $null) 'A' @('String')}",
        "case 'value of another kind' {val (fake @('A') 'DWord' 5 @() $null) 'A' @('String')}",
        "case 'value listing fails' {val $bad 'A' @('String')}",
        "case 'absent key' {sk (fake @() 'String' $null @() $null) 'S'}",
        "case 'listed key opened as nothing' {sk (fake @() 'String' $null @('S') $null) 'S'}",
        "case 'key listing fails' {sk $bad 'S'}",
        "case 'path with a part not there' {key (fake @() 'String' $null @() $null) 'A\\B'}",
      ].join("\n");
      const output = await runWindowsScript(script, RUN_BOUND_MS);
      expect(output?.trim().split(/\r?\n/)).toEqual([
        "absent value: null",
        "value: String x",
        "bytes: Byte[] 1 2",
        "listed value read as nothing: threw",
        "value of another kind: threw",
        "value listing fails: threw",
        "absent key: null",
        "listed key opened as nothing: threw",
        "key listing fails: threw",
        "path with a part not there: null",
      ]);
    },
  );

  test.runIf(process.platform === "win32")(
    "Windows: the real script answers through the real Windows PowerShell, the system drive among the drives",
    { timeout: RUN_BOUND_MS + 30_000 },
    async () => {
      const facts = await readWindowsFacts(RUN_BOUND_MS);
      expect(facts).toBeDefined();
      const drive = win32.parse(system32() ?? "").root.toUpperCase();
      expect(drive).toMatch(/^[A-Z]:\\$/);
      expect(facts?.drives.find((d) => d.root.toUpperCase() === drive)).toMatchObject({
        type: "Fixed",
      });
    },
  );

  // A1 3.2: a key or a value that is not there is no fact, but a read that fails is not "not
  // there". Each section of the real script is made to fail in turn: the run still ends normally,
  // and its output is no facts, so the folder is unchecked, never local.
  test.runIf(process.platform === "win32")(
    "Windows: a section of the real script that fails gives no facts, never the facts of the others",
    { timeout: RUN_BOUND_MS + 30_000 },
    async () => {
      const lines = WINDOWS_SCRIPT.split("\n");
      const sections = lines.flatMap((line, i) => (line.startsWith("try{") ? [i] : []));
      expect(sections.length).toBe(4);
      const outputs = await Promise.all(
        sections.map((at) =>
          runWindowsScript(
            lines
              .map((line, i) => (i === at ? `try{throw 'probe';${line.slice(4)}` : line))
              .join("\n"),
            RUN_BOUND_MS,
          ),
        ),
      );
      for (const output of outputs) {
        // The run ended (exit 0, within the bound), and what it wrote is no facts.
        expect(output).toBeDefined();
        expect(output?.trimEnd().split("\n").at(-1)).not.toBe("end");
        expect(parseWindowsFacts(output ?? "")).toBeUndefined();
      }
    },
  );
});
