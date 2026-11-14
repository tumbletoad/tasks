// What the Windows PowerShell 5.1 helper scripts share: the registry layers' reader (A4 3.8,
// environment/layers.ts) and the synced-folder check's facts run (A1 3.2, service's sync-host.ts).
// Both call .NET only, never a cmdlet, and write lines of base64 fields ending in `end`.
//
// One rule for both: a read that failed is never taken for a key or a value that is not there.
// .NET Framework's `RegistryKey.OpenSubKey` gives null both for a key that is not there and for
// most failures, `RegistryKey.GetValue` gives its default both for a value that is not there and
// for any failed query, and Windows PowerShell 5.1 turns an exception in a property getter into
// $null, even under `$ErrorActionPreference='Stop'` (measured on Windows PowerShell 5.1, the
// reader's own way of running). So:
// - Absence comes only from an enumeration that succeeded: `GetSubKeyNames` and `GetValueNames`
//   throw when they fail. A subkey or a value that is listed but opens or reads as nothing throws.
// - A value's kind is checked (`GetValueKind` throws when it fails) before it is used: one of
//   another kind throws, never becomes a string.
// - A .NET property that can fail is read through its accessor method (`$d.get_VolumeLabel()`),
//   which throws as a method does.

/**
 * Windows PowerShell 5.1 functions, as one line, for a script that runs under
 * `$ErrorActionPreference='Stop'`:
 * - `sk $key $name`: the subkey, or $null when `$key` lists no such subkey.
 * - `key $root 'A\B\C'`: the subkey at the path, or $null when a part of it is not there.
 * - `val $key $name @(kinds)`: the value (an ExpandString expanded), or $null when `$key` lists no
 *   such value; it throws for a kind not in `kinds`. A byte array comes back whole (`,$v`).
 */
export const REGISTRY_READS =
  "function sk($k,$n){if(@($k.GetSubKeyNames()) -notcontains $n){return $null};" +
  "$s=$k.OpenSubKey($n);if($null -eq $s){throw 'key'};$s};" +
  "function key($k,$p){foreach($n in $p.Split('\\')){$k=sk $k $n;if($null -eq $k){return $null}};$k};" +
  "function val($k,$n,$t){if(@($k.GetValueNames()) -notcontains $n){return $null};" +
  "if($t -notcontains $k.GetValueKind($n).ToString()){throw 'kind'};" +
  "$v=$k.GetValue($n);if($null -eq $v){throw 'value'};,$v}";

/**
 * A helper script's whole output as text, or undefined when a byte is not what the scripts write:
 * printable ASCII, a space, a line feed or a carriage return. Decoding first would hide such a
 * byte: Node's "ascii" clears each byte's high bit, so bytes that are no text could read as a
 * valid line (`end` among them), and a lenient UTF-8 decoder turns them into U+FFFD. An output
 * with any other byte is no output at all, never a part of one.
 */
export function scriptOutput(bytes: Uint8Array): string | undefined {
  for (const byte of bytes) {
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x0a && byte !== 0x0d)) return undefined;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Whether a helper's field is exactly base64 (the empty string included). */
export const isBase64 = (field: string): boolean => BASE64.test(field);

/**
 * A base64 field of a helper's line: its UTF-8 text, or undefined when it is not exactly that. A
 * leading U+FEFF is the field's own character, not a byte order mark (`ignoreBOM`), so it is kept.
 */
export function base64Text(field: string): string | undefined {
  if (!isBase64(field)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(field, "base64"),
    );
  } catch {
    return undefined;
  }
}
