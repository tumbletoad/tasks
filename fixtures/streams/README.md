# Stream fixtures

Recorded output streams of `claude -p` (A4 3.11.3, 3.11.4), turned into fixture text. They are the only part of the M0 lab that survives M0 (A7 3.7 lab rules). The print-mode stream parser is built on them and its fake agents replay them. The `codex exec --json` recordings this lab also made went with their parser: Codex runs speak its app server, recorded in `fixtures/codex-app-server/`.

Recorded on 2026-11-12 in lab run N (step M0.11, rows N01, N02, N03, N05) with Claude Code 2.1.322 and codex-cli 0.167.2:

- `windows-*`: Windows 11. `claude -p` and `codex exec --json` with full access, both CLIs.
- `linux-*`: Ubuntu 24.04 without sudo rights. `codex exec --json` only, in the default sandbox with the probe's tools on `default_tools_approval_mode = "approve"` (no full access and no Claude Code sessions there in this step).

Every run used fixture prompts only ("Call the tool probe_echo with the text hello. Then reply with the single word done."), an empty working folder, and the lab's probe MCP server registered for that run only under the name `ttasks`.

## Files

| File | What |
|---|---|
| `claude-print/<os>-<case>.jsonl` | `claude -p --output-format stream-json --verbose` stdout, one event per line |
| `index-<os>.json` | One entry per fixture: case, exit code, signal, cancel method, whether the cancel had to be forced, stderr class (from a fixed list), line count, final-line kind |
| `fields-<os>.json` | The field inventory: for each event key (`type`, `type/subtype` or `type:item.type`), every field path seen in the raw streams with its JSON types and what the sanitiser did with it. Names and types only |

Cases (each CLI has the ones its row covers):

| Case | Claude (Windows) | Codex (Windows) | Codex (Linux) |
|---|---|---|---|
| `success-tool-call`: one probe call, then a short answer | yes | yes (persisted, later resumed) | yes (ephemeral: see below) |
| `resume`: `claude --resume <id>` or `codex exec resume <id> -`, another probe call | yes (resumes the success session) | yes (resumes the success thread) | yes (resumes a different, uncommitted run) |
| `error-model`: an invalid model name | yes | yes | yes |
| `error-no-brief`: empty stdin, no stdout at all (empty file) | yes | yes | no |
| `error-not-git`: read-only sandbox outside git without `--skip-git-repo-check`, no stdout (empty file) | | yes | no |
| `error-max-turns`: `--max-turns 1` with a tool call | yes | | |
| `cancel-ctrl-c`, `cancel-ctrl-break`: a console control event while a probe call is pending (the lab's console-attach helper) | yes | yes | |
| `cancel-ctrl-c-early`: Ctrl+C about 300 ms after the turn starts | yes | yes | |
| `cancel-terminate`: TerminateProcess while a probe call is pending | yes | yes | |
| `cancel-taskkill-tree`: `taskkill /T` without `/F`, refused, forced after 10 s with `/T /F` | yes | yes | |
| `cancel-sigint-group`, `cancel-sigterm-group`: a signal to the agent's process group while a probe call is pending | | | yes |
| `killed-truncated-final-line`: the `cancel-terminate` (or `cancel-sigterm-group`) stream with its last line cut in half and no final newline | yes | yes | yes |

The Linux `success-tool-call` and `resume` fixtures are **not a recorded pair**: the success fixture comes from an ephemeral run (`--ephemeral`), and the resume fixture continues a later persisted run of the same case (`n02l-persisted`), which is not committed. Their equal fixture thread ID only means that each is the first ID of its stream; the index says so in a `note`. On Windows both CLIs' `resume` fixtures continue the session or thread of their `success-tool-call` fixture.

No run in lab run N ended inside a line: both CLIs wrote whole lines, also when killed. The truncated fixtures are therefore cut by the sanitiser, to give parsers a kill in mid-write (`final_line: "cut-by-sanitiser"` in the index). A real partial line would be kept as `partial-from-run`.

## How the sanitiser made them

The lab's sanitiser wrote every value by the fixture schema `tests/stream-schema.ts`, which stays with the content check. The schema is an explicit allow-list of fields per CLI and event type, and each allowed field has exactly one treatment with a fixed output: a known field never lets an observed value through.

| Treatment | Fields (examples) | Input it takes | Output |
|---|---|---|---|
| enum | `stop_reason`, `terminal_reason`, `result` `subtype`, `permissionMode`, `role`, MCP `status` and `source`, item `status`, the probe's tool and server names, `error` | a string from an explicit vocabulary | the value, else `unknown-value` (any other value or type) |
| bool | `is_error`, `is_api_error_message`, `completed` | a boolean | the value, else `null` |
| int | `exit_code`, `api_error_status` (100 to 599), `num_turns`, subagent counts | an integer in range | the value, else `null` |
| null | `container`, `stop_details`, `diagnostics`, `fallback_credit`, `structured_content` | only ever seen as null | `null` |
| const | settings (`output_style`, `fast_mode_state`, `view_mode`, `thinking_display`, the boolean flags of `init`), `apiKeySource`, `provider`, `costBasis`, inference metadata (`service_tier`, `inference_geo`, `speed`), rate-limit account state | anything | one fixed value (`fixture-setting`, `false`, `fixture-provider`, `fixture-inference`, `fixture_state`, …) |
| name | `model`, `canonicalModel`, `rateLimitType` | anything | `fixture-model`, `fixture-model-2`, …, `fixture_window`, consistent within a stream (`<synthetic>` stays) |
| path | `cwd`, `original_cwd`, every other path | anything | `C:\fixture\work`, `C:\fixture\path-<n>` (Windows) or `/fixture/…` (Linux), consistent within a stream |
| version | `claude_code_version`, the probe's `serverInfo.version` | a strict `major.minor.patch[-tag]` string | the value, else `0.0.0` |
| id | session, event, thread, message, tool-use, request and item IDs | anything | a synthetic ID by the field's meaning (`00000000-0000-4000-8000-<n>`, `msg_fixture<n>`, `toolu_fixture<n>`, `req_fixture<n>`, `item_<n>`), consistent within a stream, never any part of the input |
| time | `timestamp`, `credential_expires_at`, `resetsAt` | anything | the fixed series from `2026-01-01T00:00:00.000Z` (+1 s) or epoch `1767225600` (+1 h) |
| text, error, signature | every model- or tool-written text, error messages, thinking signatures | anything | `Fixture text.`, `Fixture error message (<class>).` with a class from a fixed list, `fixture-signature` (an empty string stays empty) |
| number | token counts, request counts, durations, costs, limits, ratios | anything | one fixture number per kind (`100` tokens, `1000` ms, `0.001` USD, …): the type stays, the measurement goes |
| list | `tools`, `matches`, `capabilities`, `skills`, `agents`, `plugins`, slash commands, `additional_directories` | a list | rebuilt from a fixture vocabulary: a few invented entries plus the probe's own tools the input named; never the observed list (an empty list stays empty) |

Containers: an object keeps only its allowed fields; a map whose keys are data (`modelUsage`, `memory_paths`, `unifiedWindows`, `wire_tool_inputs`, `by_type`) gets synthetic keys; `mcp_servers` keeps the probe server `ttasks` only; a content block or item of an unknown type keeps only `{"type":"unknown-value"}`; an event type the schema does not know becomes `{"type":"unknown-event"}`.

The inventory (`fields-<os>.json`) records, per event key and field path, the JSON types seen and what was really done (`kept`, `placeholder`, `fixture-value`, `synthetic-id`, `rebuilt-list`, `dropped`, …). A field name that is not on the allow-list is never written: it shows as `<unknown-<n>>` with its JSON type, and map keys show as `<map-key>`. In these recordings nothing was dropped.

The event order, the number of lines, the field names, their order and JSON types are the run's own. The session or thread ID is the first ID of each stream, so every fixture's session or thread ID is `…000000000001`.

On 2026-11-12 the committed fixtures were run through this sanitiser again (`lab.ts resanitise`, from their committed form: the raw streams were already removed with their scratch folder). That replaced what the first sanitiser had kept: the observed built-in tool and capability lists, setting values, exact model strings, inference metadata, exact usage and cost numbers and the rate-limit window name. The CLI version strings stay, so M6.05 knows which version a shape came from. Line structure, field names and JSON types were compared before and after and are unchanged; the inventories list the same event keys, paths, types and counts. The rebuilt `tools` list names only invented entries and the probe's tools, so it no longer lists `ToolSearch`, which the Claude streams still call.

## Content check

`tests/stream-content.test.ts` runs in CI on every machine. Two layers:

1. **A scan** of each fixture line, parsed: every key and every string value, decoded, is checked separately for a home path (`/home/<name>`, `/Users/<name>`, `/root`, `C:\Users`), an e-mail address, a token or key shape, an IPv4 or IPv6 address, or the user name, host name or home folder of the machine it runs on (a deny-list built at run time and never written down). A cut final line is scanned raw and with its JSON escapes decoded. The inventories and indexes get the same scan.
2. **Structural assertions** (`tests/stream-schema.ts`): every value in a fixture event must be one its treatment can produce (an ID of the fixture pattern, a time of the fixed series, a fixture text, a vocabulary value, a fixture number, a rebuilt list); every field must be on the allow-list; every inventory path must be a schema path or a placeholder; every index field must be a known kind of value. A truncated fixture must be its source stream with the last line cut.

The scan cannot recognise an arbitrary private name (a person, a customer, a project) in a field whose values the structure does not constrain: it knows shapes and this machine's names only. The structural assertions are the guarantee: in the stream fixtures no string field is free. The index's `case` and `note` texts are written by the lab's own code.

The lab ran both layers before it published anything: every output was built and checked in the run's scratch folder, and only when all passed were they copied here. Raw streams never left their scratch folder, and the Linux recordings were sanitised on the machine that made them.

## Regenerating

The lab that recorded and sanitised these streams is removed. A new recording needs a sanitiser that writes every value by `tests/stream-schema.ts` and passes the content check before anything is copied here. Never edit a fixture by hand to add content.
