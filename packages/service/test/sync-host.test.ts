// The Windows facts run of the synced-folder check (A1 3.2, sync-host.ts): how often it runs, and,
// on Windows, the real script through the real Windows PowerShell. The real run reads this
// machine's drives and sync-client keys; the test looks only at the drive that holds the system
// folder and prints nothing it read.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { REGISTRY_READS } from "@ttasks/launch";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { system32 } from "../src/hub/identity.ts";
import { CHECK_TIMEOUT_MS, type WindowsSyncFacts } from "../src/hub/sync-folders.ts";
import {
  DRIVE_FACTS,
  readWindowsFacts,
  realSyncHost,
  runWindowsScript,
  WINDOWS_SCRIPT,
  windowsFactsOf,
  windowsFactsOnce,
  withVolumes,
} from "../src/hub/sync-host.ts";
import { NO_WINDOWS } from "./sync-fixtures.ts";

/** The real runs' bound in these tests: the product's, which only ends a run that hangs. */
const RUN_BOUND_MS = CHECK_TIMEOUT_MS;

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

  test("each local drive's volume identity is read right after the facts; a network drive's root never, and one not read within the bound is left without one", async () => {
    const drive = (root: string, type: string) => ({ root, type, format: "", label: "" });
    const facts = {
      ...NO_WINDOWS,
      drives: [
        drive("C:\\", "Fixed"),
        drive("N:\\", "Network"),
        drive("E:\\", "Removable"),
        drive("H:\\", "Fixed"),
      ],
    };
    const read: string[] = [];
    const out = await withVolumes(
      facts,
      (root) => {
        read.push(root);
        if (root === "E:\\") return Promise.reject(new Error("a failed look"));
        // A look that never answers: the bound ends it, whatever the machine's load.
        if (root === "H:\\") return new Promise<never>(() => undefined);
        return Promise.resolve(`id-${root[0] ?? ""}`);
      },
      20,
    );
    expect(read.sort()).toEqual(["C:\\", "E:\\", "H:\\"]);
    expect(out.drives.map((d) => d.volume)).toEqual(["id-C", undefined, undefined, undefined]);
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

  // The reads both helper scripts share (@ttasks/launch windows-reads.ts), on fake keys that answer
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
      expect(output?.toString("utf8").trim().split(/\r?\n/)).toEqual([
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
      // Its volume identity was read with the facts: the one a folder on the drive has.
      const host = realSyncHost({ windowsFacts: () => Promise.resolve(undefined) });
      expect(facts?.drives.find((d) => d.root.toUpperCase() === drive)?.volume).toBe(
        await host.volumeOf(drive),
      );
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
        expect(output?.toString("utf8").trimEnd().split("\n").at(-1)).not.toBe("end");
        expect(windowsFactsOf(output ?? Buffer.alloc(0))).toBeUndefined();
      }
    },
  );

  test("the run's output is checked byte by byte before it is read: a byte the script never writes is no facts", () => {
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const good = `drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")} ${b64("")}\nend\r\n`;
    expect(windowsFactsOf(Buffer.from(good, "latin1"))?.drives).toHaveLength(1);
    // "end" with each byte's high bit set reads as "end" once the high bit is cleared, as Node's
    // "ascii" decoding does; a NUL, a byte past ASCII, a lone byte of UTF-8.
    for (const bad of [
      Buffer.from([0xe5, 0xee, 0xe4]),
      Buffer.concat([
        Buffer.from(good.replace("end", ""), "latin1"),
        Buffer.from([0xe5, 0xee, 0xe4]),
      ]),
      Buffer.from(`${good}\u0000`, "latin1"),
      Buffer.from(good.replace("drive", "dr\u00e9ve"), "utf8"),
      Buffer.from([...Buffer.from(good, "latin1"), 0xc3]),
    ]) {
      expect(windowsFactsOf(bad)).toBeUndefined();
    }
  });

  test("a second line for one drive, or a second Drive for desktop value, is output of another shape: no facts, never one line replacing another (review round 2)", () => {
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const drive = (root: string, label: string) =>
      `drive ${b64(root)} ${b64("Fixed")} ${b64("NTFS")} ${b64(label)}\n`;
    const value = (text: string) => `drivefs ${Buffer.from(text, "utf16le").toString("base64")}\n`;
    const one = `${drive("C:\\", "")}${value("D:\\mirror")}end`;
    expect(windowsFactsOf(Buffer.from(one, "latin1"))?.drives).toHaveLength(1);
    for (const bad of [
      `${drive("Q:\\", "Google Drive")}${drive("q:\\", "")}end`,
      `${value("D:\\mirror")}${value("D:\\other")}end`,
    ]) {
      expect(windowsFactsOf(Buffer.from(bad, "latin1")), bad).toBeUndefined();
    }
  });

  // The drives' line on fake drives that answer the accessors the function calls: .NET's DriveType
  // answers Unknown or NoRootDirectory when the system cannot tell, and IsReady answers false when
  // it fails, so neither may stand in for a drive's type. No drive is read.
  test.runIf(process.platform === "win32")(
    "Windows: a drive of a type the system could not determine is left out, as one that is not ready, and a network drive's readiness is never asked",
    { timeout: RUN_BOUND_MS + 30_000 },
    async () => {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$e=[Text.Encoding]::UTF8",
        "function b($s){[Convert]::ToBase64String($e.GetBytes([string]$s))}",
        DRIVE_FACTS,
        "function m($o,$n,$b){$o.PSObject.Methods.Add([Management.Automation.PSScriptMethod]::new($n,$b))}",
        // 'throw' on the left: PowerShell compares to the left operand's type, and $true -eq any
        // non-empty string.
        "function fake($name,$type,$ready,$format,$label){$d=[psobject]::new();m $d 'get_Name' ({$name}.GetNewClosure());m $d 'get_DriveType' ({if('throw' -eq $type){throw 'type'};$type}.GetNewClosure());m $d 'get_IsReady' ({if('throw' -eq $ready){throw 'ready'};$ready}.GetNewClosure());m $d 'get_DriveFormat' ({if('throw' -eq $format){throw 'format'};$format}.GetNewClosure());m $d 'get_VolumeLabel' ({if('throw' -eq $label){throw 'label'};$label}.GetNewClosure());$d}",
        "function case($name,$d){$o=[Text.StringBuilder]::new();try{dr $d;$t=$o.ToString().TrimEnd([char]10);if($t -eq ''){$t='none'};[Console]::Out.WriteLine($name+': '+$t)}catch{[Console]::Out.WriteLine($name+': threw')}}",
        "case 'unknown' (fake 'U:\\' 'Unknown' $true 'NTFS' '')",
        "case 'no root' (fake 'R:\\' 'NoRootDirectory' $true 'NTFS' '')",
        "case 'not ready' (fake 'E:\\' 'Removable' $false 'throw' 'throw')",
        "case 'network' (fake 'Z:\\' 'Network' 'throw' 'throw' 'throw')",
        "case 'fixed' (fake 'C:\\' 'Fixed' $true 'NTFS' 'Disk')",
        "case 'label fails' (fake 'D:\\' 'Fixed' $true 'NTFS' 'throw')",
        "case 'type fails' (fake 'F:\\' 'throw' $true 'NTFS' '')",
      ].join("\n");
      const output = await runWindowsScript(script, RUN_BOUND_MS);
      const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
      // An empty field is still written, so a line may end in spaces: only line ends are trimmed.
      expect(output?.toString("utf8").replace(/\s*$/, "").split(/\r?\n/)).toEqual([
        "unknown: none",
        "no root: none",
        "not ready: none",
        `network: drive ${b64("Z:\\")} ${b64("Network")} ${b64("")} ${b64("")}`,
        `fixed: drive ${b64("C:\\")} ${b64("Fixed")} ${b64("NTFS")} ${b64("Disk")}`,
        "label fails: threw",
        "type fails: threw",
      ]);
    },
  );
});

describe("[A1.5.sync.fails-closed] the real host's looks: nothing there only for a name that is not there, every other failure thrown", () => {
  let root = "";
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sync-host-")));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a folder, a file, a link to nothing and a name not there; a small text file, one too large, one not UTF-8", async () => {
    const host = realSyncHost({ windowsFacts: () => Promise.resolve(undefined) });
    const folder = join(root, "folder");
    mkdirSync(folder);
    const file = join(root, "file.txt");
    writeFileSync(file, "text");
    const target = join(root, "gone");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true });
    expect(await host.kind(folder)).toBe("directory");
    expect(await host.kind(file)).toBe("other");
    expect(await host.kind(link)).toBe("other");
    expect(await host.kind(join(root, "missing"))).toBe("absent");
    expect(await host.kind(join(file, "below"))).toBe("absent");
    expect(await host.exists(link)).toBe(true);
    expect(await host.exists(join(root, "missing"))).toBe(false);
    expect(await host.realpath(join(root, "missing"))).toBeUndefined();
    expect(await host.realpath(folder)).toBe(folder);
    await expect(host.list(join(root, "missing"))).rejects.toThrow();
    expect(await host.readText(file, 4)).toBe("text");
    expect(await host.readText(join(root, "missing"), 4)).toBeUndefined();
    await expect(host.readText(file, 3)).rejects.toThrow();
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    await expect(host.readText(file, 16)).rejects.toThrow();
    // A folder is not a text file: a failure, not "not there".
    await expect(host.readText(folder, 16)).rejects.toThrow();
  });

  test.runIf(process.platform === "win32")(
    "Windows: a folder and its drive's root are on one volume, by its serial number",
    async () => {
      const host = realSyncHost({ windowsFacts: () => Promise.resolve(undefined) });
      const drive = win32.parse(root).root;
      expect(await host.volumeOf(root)).toBe(await host.volumeOf(drive));
      await expect(host.volumeOf(join(root, "missing"))).rejects.toThrow();
    },
  );

  test.runIf(process.platform === "linux")(
    "Linux: a look below a folder it may not search fails, never answers nothing there",
    async () => {
      const locked = join(root, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        const host = realSyncHost();
        // Root reads anything: the look then succeeds, which proves nothing either way.
        if (process.getuid?.() === 0) return;
        await expect(host.kind(join(locked, "inner"))).rejects.toThrow();
        await expect(host.exists(join(locked, "inner"))).rejects.toThrow();
        await expect(host.realpath(join(locked, "inner"))).rejects.toThrow();
        await expect(host.list(locked)).rejects.toThrow();
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
