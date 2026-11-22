# Lab run L: trust writes and their undo (M0.10, row L10)

Lab code for row L10 of A7 3.7 (A4 3.14 and M0-L16). Never shipped, never imported outside `spikes/`. No dependency: Node built-ins and lab run A's helpers in `../agents/` (the clean spawner, the removal rule, the config recorder, the error classes). The other L rows need the maintainer and run in lab sessions 1 and 2 (A7 3.7).

The row writes a folder-trust entry into a scratch Claude Code home (`projects["<path>"].hasTrustDialogAccepted = true` in `.claude.json`) and a scratch Codex home (`[projects.'<path>'] trust_level = "trusted"` in `config.toml`), then takes it back. No model session is started and no real home is read or written (A7 3.7's lab rules apply as written).

| File | Part |
|---|---|
| `trust-patch.ts` | The patch and its inverse for both files, as TTasks's later pre-trust would do it: a text-level single-key patch (a scanner finds the key's span, one splice in the file's own line ending, indentation and colon spacing), never parse and re-serialise, so comments, order and whitespace stay. The undo record holds only the splice (TTasks's own text and the key's previous value) and the file's hashes, never a copy of the file. The undo reverses the splice while the hash is unchanged, so the bytes come back identical, and reverts only TTasks's key when the app changed the file since. Layouts it does not edit (an inline `projects` table, a bare `[projects]` table with dotted keys, `[[projects]]`) are refused untouched, and so is a file the scanner cannot account for (an unterminated string, unmatched brackets, text after a value, a bare carriage return, a table or key twice, invalid UTF-8, or a trust value that is not a plain value). The key-level undo leaves a key that no longer holds TTasks's value alone (`key changed`). `claudeTrustKey` and `codexTrustKey` spell the key as the CLIs were observed to look it up. `readTrust` reads the state read-only |
| `fixtures.ts` | The "restored exactly" cases: no file, no projects, other entries, an empty projects object, an entry without the key, an entry with another value, already trusted, CRLF with tabs and odd spacing, minified, a key in `\u` escapes, a byte order mark (JSON); no file, comments and a multi-line array without a final newline, other project tables, spaced headers with comments and a header-like line inside a multi-line string, CRLF, an entry with another value, an entry with only a comment, already trusted, a basic-string key, a byte order mark, and two refused layouts (TOML) |
| `lab.ts` | `l10` (in a new or empty scratch folder only): CLI versions, the key-spelling matrix and the write-undo cycles through the real CLIs, with result files `l10-key-spelling.json`, `l10-write-undo.json` and `l10-pids.json` |
| `launch.test.ts` | Self-test on fixture files, no CLI (`[A7.3.7.m0-launch.trust-patch]`): every case patched and undone, checked with the config recorder and byte for byte; the undo record holds no other content; refusals; the case-folded Codex match on Windows; a file changed after the patch reverts only TTasks's key |

**How trust is seen without a session.** Claude Code applies a project's own `.mcp.json` approval (`enableAllProjectMcpServers` in the project's `.claude/settings.json`) only in a trusted folder, so `claude mcp list` in the folder shows the marker server as "Pending approval" until the folder is trusted. Codex loads a project's `.codex/config.toml` only for a trusted project, so `codex mcp list --json` lists its marker server only then. The lab records the class (trusted, untrusted, marker absent, failed), never the output.

Run with the repository's Node on Windows, with `<s>` a new scratch folder:

```
pnpm exec node spikes/m0/launch/lab.ts l10 --scratch <s> --results <results folder>
```

On Linux, with `<s>` a new scratch folder, copy `launch/{lab,trust-patch,fixtures}.ts`, `agents/{clis,config-record,facts,scratch,spawn}.ts` and `kit/wire.ts` to the same paths under `<s>/lab/spikes/m0/`, with a `package.json` of `{"type":"module"}` in `<s>/lab/`, install the signed `linux-x64` spike archive into `<s>/install`, and run `lab.ts` with its `runtime/node`. Then remove the scratch folder by its full name, never its parent.
