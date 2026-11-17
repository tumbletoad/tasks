# codex app-server recordings

What a real `codex app-server` (codex-cli 0.169.0, on Windows 11) said to a client and what the client said to it, one process per file, recorded on 2026-11-17 with a small model at low effort, trivial requests and an empty working folder. The run driver's fake app server (`packages/runs/test/codex-server.ts`) replays them.

Each line is `{"dir", "ms", "msg"}`: `send` (client to server), `recv` (server to client), `stderr`, the recorder's own `mark`, and the process's `exit`. `ms` counts from the start of the process.

| File | Case |
|---|---|
| `windows-plain` | a turn with full access |
| `windows-command` | a turn that runs a command; its thread is kept for `resume` |
| `windows-tool` | a tool call to an MCP server the thread's configuration names |
| `windows-interrupt` | `turn/interrupt` while a command runs |
| `windows-background` | a command left running as a background terminal, completed after the turn |
| `windows-background-detached` | a command that starts a detached process: nothing about it is reported |
| `windows-approval-command` | a command asked about and accepted (`untrusted`, read-only) |
| `windows-approval-file` | a file change asked about and declined (`on-request`, read-only) |
| `windows-question` | a blocking question for the person in plan mode, left open and interrupted |
| `windows-resume` | the `command` thread resumed in a new process, then deleted |

Made by `tests/codex-app-server/record.ts` and `sanitise.ts`. The sanitiser keeps the protocol's own words, method names and field names; every other string becomes a synthetic ID, a fixture path, `Fixture text.` or a fixture name, times keep only their distance from the stream's first, and counts become fixture numbers. `tests/codex-app-server/content.test.ts` checks that every committed value is one the sanitiser can write. Never edit a fixture by hand.
