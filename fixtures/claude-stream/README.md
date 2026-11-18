# Claude Code print-mode recordings

What a real Claude Code (2.1.325, on Windows 11) said to a client and what the client said to it in print mode with JSON lines both ways (`claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`), one process per file, recorded on 2026-11-17 with the smallest model, trivial requests, an empty working folder and no session kept on disk. The run driver's fake Claude Code (`packages/runs/test/claude-fake.ts`) replays them.

Each line is `{"dir", "ms", "msg"}`: `send` (client to program), `recv` (program to client), `stderr`, the recorder's own `mark` (`stdin end`: the client ended the program's input), and the process's `exit`. `ms` counts from the start of the process.

| File | Case |
|---|---|
| `windows-plain` | a turn with full access (`bypassPermissions`) |
| `windows-command` | a turn that runs a command |
| `windows-tool` | a tool call to an MCP server named `tasks` in a file given with `--mcp-config` |
| `windows-background` | a command started in the background: the turn ends, the program starts a turn of its own when the command ended, and the input ends after that turn |
| `windows-background-agent` | a helper agent started in the background: the turn ends, the helper works and ends, and the program starts a turn of its own about it |
| `windows-stop-background` | the same, stopped after the first turn: an interrupt with no turn going on, then the end of the input, which ends the background command |
| `windows-interrupt` | an interrupt (`control_request` `interrupt`) while a command runs |
| `windows-question` | `AskUserQuestion` reaches the client as `can_use_tool` with `requires_user_interaction`; denied with `interrupt: true` and interrupted |
| `windows-denied` | a permission prompt (`manual` mode) reaches the client as `can_use_tool` and is denied: the result counts it in `permission_denials` |
| `windows-signed-out` | an empty home of its own: the program's own words, `is_error: true`, exit 1 |

Made by `tests/claude-stream/record.ts` and `sanitise.ts`. The sanitiser keeps the protocol's own words, event types and field names and the built-in tools' names; every other string becomes a synthetic ID, a fixture path, a fixture name, a fixed time or `Fixture text.`, and numbers become fixture numbers. `tests/claude-stream/content.test.ts` checks that every committed value is one the sanitiser can write. Never edit a fixture by hand.
