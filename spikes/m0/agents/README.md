# Lab run A: agent integration (M0.09)

Lab code for the A rows and E02 of A7 3.7. Never shipped, never imported outside `spikes/`. It is a private workspace package only so it can hold lab-only dependencies: the official MCP SDKs (`@modelcontextprotocol/sdk` 1.32.2, MIT; `@modelcontextprotocol/client` and `server` 2.4.0, Apache-2.0) and `gpt-tokenizer` 4.1.2 (MIT). The sign-in rule, what the lab may touch in agent homes and the rules below: A7 3.7's lab rules. The rows that need the maintainer run in lab sessions 1 and 2 (A7 3.7).

Rules the code enforces:
- **Facts only.** Nothing a CLI, a model or the OS says in its own words reaches the console, a log or a result file. The lab keeps an error class from a fixed list, exit codes, yes or no, counts and token numbers, and names only from fixed lists (else `[other]`). Every program's top-level boundary prints an error class, never a message, a path or a stack (`facts.ts`).
- **One removal rule.** Every removal goes through `scratch.ts`: the target must lie strictly inside the run's own scratch folder after resolution (never the folder itself, above it or a sibling; without case on Windows; no links), and a folder must carry the run's marker file. The scratch folder itself, and never its parent, is removed by hand at the end.
- **One cleanup path.** Every child (the CLIs and the stand-in services) ends through `spawn.ts` on a normal end, an error, SIGINT and SIGTERM: graceful first, a bounded wait, then forced; on POSIX the child's whole process group.
- **Sessions:** one user prompt each (the model may take several turns; `num_turns` is recorded), settings per launch only, no configuration write in a signed-in home, no trust or approval setting ever.

| File | Part |
|---|---|
| `spawn.ts` | The clean spawner: every CLI gets an environment from an allow-list plus the variables a sub-check sets, never the agent variables of the shell the lab runs in. The cleanup path (`track`, `endChild`, `endAll`, `installCleanup`) |
| `scratch.ts` | The removal rule (`openScratch`, `isStrictlyInside`) and E02's fixed mode list |
| `facts.ts` | Error classes for the program boundaries, fixed-list and number filters |
| `probe.ts` | The probe MCP server (both eras through the kit's stub responder). One result file per start: names from a fixed list, the ticket and IDs as present, equal and format, protocol version and client label, methods, tool calls, `_meta` key names. Never a value. `--tools a09`, `--instructions markers` and `--instructions-file` for A09 and A06 |
| `config-record.ts` | Key-level records (keys and a hash per value, a hash of every file; `recordHome` walks a scratch home, `recordFiles` reads only named files of a real home), the before and after comparison over every named file, the real homes' MCP key names, and `entryRecord`: the entry-level backup of a registration (TTasks's key paths with their previous value or absence, and the file hash), never a file copy |
| `clis.ts` | Where `claude` and `codex` are: `claude.exe` and `node codex.js` on Windows, the login shell's `command -v` and PATH on Linux (`TTASKS_M0_TEST_CLIS`: fake CLIs for the self-test) |
| `lab.ts` | The commands: `spawner-check`, `a01-config`, `a01-sessions`, `a02-config`, `a02-sessions`, `a06`, `a06-length` (the first, sequence-naming follow-up), `a06-markers` (random markers at known offsets), `a07`, `a08` (`o200k_base`, exact), `a08-claude` (the indirect Claude estimate with interleaved baselines), `a09`, `e02`, `real-keys` |
| `a07.ts`, `a07-server.ts` | Official clients of both eras through the kit forwarder, and the server SDK's one-object question |
| `corpus.ts` | A08's corpus, the 12 definitions and 10 rendered results of the repeat, and the estimator |
| `agents.test.ts` | Self-test with fake CLIs and fake processes (`[A7.3.7.m0-agents.self-test]`); no test starts a real agent CLI |

Run with the repository's Node: `pnpm exec node spikes/m0/agents/lab.ts <command> --scratch <s>`, with `<s>` a new scratch folder. On Linux, copy a hoisted `pnpm --filter @ttasks/m0-agents deploy --prod --legacy --config.node-linker=hoisted <dir>` next to `spikes/m0/kit/*.ts` and run it with the packaged Node of the spike archive. Model sessions are counted in `<scratch>/ledger.json` and capped per machine; `a06-markers` takes at most 12 sessions and `a08-claude` at most 60.
