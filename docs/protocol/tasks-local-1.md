# tasks-local/1

The local protocol between the Tasks service and its clients on the same machine: the CLI, the launch shim, the MCP bridge and any native forwarder. A2 3.6 specifies it. This page is the reference an implementer needs. The Node implementation is `@tasks/bridge/protocol` (wire code and client) and `@tasks/service/local` (server).

## Endpoint

- Linux and macOS: a Unix stream socket `tasks.sock` in a folder only its user can enter (0700). On Linux that folder is `/run/user/<uid>/tasks-<install-id>/` when the per-user runtime folder is a private folder of this user (never taken from `XDG_RUNTIME_DIR`), else `<state>/run/`. A socket path holds at most 100 bytes, and both sides refuse a longer one before they try.
- Windows: a named pipe in byte mode, `\\.\pipe\tasks-<install-id>-<instance>`. The instance ID is new at every start.
- The path is `endpoint.path` in `<state>/service.json`. `ENOENT` or `ECONNREFUSED` means the service is not running.
- The key is `<state>/ipc.key`: 32 random bytes as base64url (43 characters), optionally followed by one line ending. The HMAC key is the 32 decoded bytes. A client reads it for every connection, so a key rotation needs nothing else.

## Framing

- UTF-8, one JSON-RPC 2.0 message per line, each line ended by `\n`. No BOM. JSON escapes every newline inside a message. Bytes after the last `\n` are not a message.
- Line limits: before the client's proof verifies, the service reads at most 1 KiB in all (a valid hello is about 170 bytes). The bind frame holds at most 1 MiB. After the handshake a line holds at most 8 MiB.
- A line over the limit after the handshake gets `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"frame_too_large"}}`, then the service closes.
- No keepalives. The socket's close is the liveness signal.
- Backpressure is the stream's. While its output to a peer is backed up, the service reads nothing more from that peer, and its lines wait in order. Two bounds hold what waits:
  - In time: while output waits, the peer must take some of it within 30 s, or the service closes it as not reading. The clock runs only while output waits and starts again whenever the peer takes bytes, so a slow but steady reader of a large burst is never closed. New output does not restart it.
  - In size: lines the service offers (notifications, mcp lines) may wait up to 16 MiB, past which the service closes the peer as not reading. Replies do not count: at most 64 can be due at once (the in-flight limit) and each is at most 8 MiB, so a connection's waiting output never passes 64 × 8 MiB + 16 MiB.
- The service holds at most 64 connections that are not yet authenticated and 256 in all. One more is closed at accept.

## Handshake

```
S → C  {"jsonrpc":"2.0","method":"tasks/challenge","params":{"nonce":Ns,"instance":I,"protocols":[…]}}
C → S  {"jsonrpc":"2.0","id":0,"method":"tasks/hello","params":{"protocol":P,"mode":M,"nonce":Nc,"proof":Pc}}
S → C  {"jsonrpc":"2.0","id":0,"result":{"proof":Ps}}
C → S  {"jsonrpc":"2.0","id":1,"method":"tasks/bind","params":{"protocol":P,"mode":M,"client":{…},"context":{…},"mac":Mb}}
S → C  {"jsonrpc":"2.0","id":1,"result":{…,"mac":Ms}}
```

Nonces and proofs are 32 bytes as base64url without padding (43 characters), in their one canonical spelling. `I` is the service's instance ID (`[A-Za-z0-9_.:-]`, at most 128 characters). `P` is the client's own protocol number, an integer from 1. `M` is `rpc` or `mcp`. A challenge lists 1 to 8 distinct protocol numbers. `H` is SHA-256 in lowercase hex and `JCS` is RFC 8785 canonical JSON.

```
Pc = b64url(HMAC-SHA256(key, "tasks-local/1 client\n" + I + "\n" + P + "\n" + M + "\n" + Ns + "\n" + Nc))
Ps = b64url(HMAC-SHA256(key, "tasks-local/1 server\n" + I + "\n" + P + "\n" + M + "\n" + Nc + "\n" + Ns))
Ks = HMAC-SHA256(key, "tasks-local/1 session\n" + I + "\n" + Ns + "\n" + Nc)
T  = H("tasks-local/1 transcript\n" + I + "\n" + Ns + "\n" + Nc + "\n" + JCS(challenge protocols)
       + "\n" + JCS({protocol, mode, client, context}))
Mb = b64url(HMAC-SHA256(Ks, "tasks-local/1 bind\n" + T))
Ms = b64url(HMAC-SHA256(Ks, "tasks-local/1 bound\n" + T + "\n" + H(JCS(result without mac))))
```

Each message has exactly the fields shown, no more. Values that canonical JSON covers nest at most 64 levels deep.

Rules for the client:

- Before `Ps` verifies, send nothing but the hello line. A challenge that is malformed or followed by other bytes gets no byte at all.
- Compare `Ps` and `Ms` in constant time. A wrong, missing or late `Ps`, or a proof line followed by other bytes, is `untrusted_endpoint`: close and report it.
- Hash the bind body exactly as sent: serialise it, parse it back, and compute `T` from that. Check the bind frame's size before connecting.
- Check `Ms` before reading any field of the bind result. Then the result's `protocol` must equal the client's, `service` must hold string `version`, `build` and `instance`, `capabilities` must be strings and `spaces` an array. Anything else is `service_too_old`.
- Default timeouts: 5 s from the connect call to the connection, 5 s from the connection to a verified bind result.

Rules for the service:

- Send nothing before the hello but the challenge. Send `Ps` only after `Pc` verifies.
- Refuse a hello with any other field, any malformed value, or any byte after it. Check `Mb` before anything else in the bind, then require the bind's protocol and mode to equal the hello's.
- A hello or bind that fails (a wrong proof or `Mb`, a malformed or pipelined message, a mismatch with the hello) gets no further byte and is closed after a fixed 200 ms. A handshake not authenticated within 5 s of accept is closed at once.
- Compute `Ms` over the bind result as the client will parse it: serialise it, parse it back, and hash that.

Canonical JSON follows RFC 8785 with I-JSON input. A string or key with a lone surrogate cannot be canonicalised, so a bind that holds one fails, and both sides refuse it.

## Bind

`client` is `{kind, version, build, pid, package, tty: {stdin, stdout}}`. `kind` is `cli` or `shim` in rpc mode and `bridge` or `forwarder` in mcp mode. `version` and `build` hold 1 to 64 characters. `pid` is a non-negative integer. `package` is the package identity of a packaged parent on Windows (at most 256 characters), else null. Unknown fields make the bind invalid.

`context` is an object:

- rpc mode: `{env: {NAME: value}}` with only the agent markers (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, names starting with `CODEX_SANDBOX`, `T3CODE_THREAD_ID`, `TASKS_TICKET`, `TASKS_TASK`) and `TASKS_SPACE`. A3 keeps the marker list.
- mcp mode: `{space, instance, app, cwd, env, parent: {pid}}`, with `null` for a missing argument, plus `mcp_init` (the client's latest `initialize` or `server/discover`, once answered, at most 64 KiB) and `resume: {handle}` (the handle of the bridge's last bind). `env` holds only `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `T3CODE_THREAD_ID`, `TASKS_TICKET`, `TASKS_TASK` and `TASKS_SPACE` (`MCP_CONTEXT_ENV`), each at most 256 characters and well-formed. A `cwd` over 4,096 characters or with a lone surrogate is sent as null.

The result is `{protocol, service: {version, build, instance}, capabilities, spaces, binding, mac}`:

- `spaces` lists each space as `{entry, id, name, ref_prefix, state, reason}`, without its holder or path.
- `binding` is null in rpc mode. In mcp mode it is A3 3.7's `{handle, space, state}`.

A refusal is `{protocol, service, refused: {reason, min, max}, mac}`, sent at once with its proof, after which the service closes. Reasons: `client_too_old`, `service_too_old`, `invalid_bind` (a client or context that does not parse, or a kind that does not fit the mode), `mode_unsupported`. A bind whose grants row is revoked or not live is closed without a result, and revoking a row closes every connection that uses it.

The service accepts the protocols it lists in the challenge (`[current - 1, current]`). A client outside that range is refused as too old or too new, in an authenticated result.

## Modes

**rpc** (CLI, shim): JSON-RPC requests after the bind. The class of the connection decides which methods it may call:

| Methods | Classes |
|---|---|
| `op/call`, `op/list`, `feed/subscribe`, `service/status`, `space/list`, `roots/list` | `cli-interactive`, `cli-script`, `cli-agent` |
| `service/shutdown`, `ui/mint_code` | `cli-interactive`, `cli-script` |
| `service/port`, `space/create`, `space/open`, `space/close`, `space/backup`, `space/backups`, `space/restore`, `space/claim`, `space/recover`, `view/rebuild`, `roots/add` | `cli-interactive` only: the person's |
| `launch.claim`, `launch.attach`, `launch.started`, `launch.settled`, `launch.exited`, `launch.failed`, `run.attach`, `run.event`, `run.exited` | `shim` only. Each checks its own credential (A4) |

- `op/call {space?, op, input, request_id?}` calls one registry entry and answers its result or A3's error body. `space` is a space ID or name. `op/list {}` answers `{entries: [{name, kind, actors, summary}]}`, sorted by name.
- `service/shutdown {restart?, reason?}` answers `{state: "draining", restart}`, then the service drains. `reason` is a lower-case word and is not logged.
- `$/cancel {"id": …}` cancels a request. Other notifications are ignored.
- A3's errors travel as code `-32000` with A3's error body in `data`. Other codes: `-32700` parse error (also a line that is not UTF-8), `-32600` invalid request, `-32601` method not found (also a method this service has no handler for), `-32602` invalid params, `-32603` internal error, `-32800` cancelled. An internal error carries nothing from the failure.
- A method the connection's class may not call gets `-32000` with `forbidden` (`data: {reason: "connection_class", class}`).
- A request's `id` is a safe integer or a string of at most 128 characters. `null` is refused as an invalid request: the service answers unidentifiable messages with `id: null`, so a request with that ID could not be told apart. A second request with the ID of one in flight is an invalid request. `method` is a string and `params`, when present, an object. A message without `method` is a response only with exactly one of `result` and `error`, and is then not answered. Anything else is an invalid request. `jsonrpc` must be `"2.0"`.
- A connection has at most 64 requests in flight. The service answers one more at once with `-32000` and A3's `too_large` (`data: {reason: "in_flight", max}`) and keeps reading, so `$/cancel` always arrives. A cancelled request counts until the service answers it. The Node client never sends more and queues the rest.
- The service sends rpc notifications (`feed/event`, the shim's `cancel`) only for a request in flight.
- While the service drains, an rpc connection still reads `$/cancel`, answers every new request with `service_unavailable` (`not_running`, retryable), and ends once no request is in flight. So the reply to `service/shutdown` reaches its caller.

**mcp** (bridge, forwarder): after the bind result, every line in both directions is an unchanged MCP message. A line that is not UTF-8 is dropped. The service may send the first lines right behind the bind result, in the same chunk. The Node client keeps them until its line handler is set and reports the close only after them. A consumer whose own output is backed up calls `pause()`, which stops reading the socket and holds what was already read, and `resume()` once it can take lines again.

## The forwarder (`tasks mcp`)

The Node bridge is `@tasks/bridge/mcp` (A2 3.7). A native forwarder implements the same contract and passes the conformance suite: `TASKS_BRIDGE_BIN=<binary> pnpm exec vitest run --project product tests/forwarder`. In short:

- Arguments `--space`, `--instance`, `--app`, each optional, as `--name value` or `--name=value`. Anything else exits 2. stdout carries MCP messages only. Diagnostics go to stderr without content.
- Discovery per attempt: `endpoint.path` from `<state>/service.json`, and `<state>/ipc.key`. `<state>` and `<cache>` are `$TASKS_HOME/state` and `$TASKS_HOME/cache` when `TASKS_HOME` is set (it must be absolute), else `~/.tasks/state` and `~/.tasks/cache` (A2 3.2.1). The home folder comes from the account (`USERPROFILE` on Windows), never from `XDG_*` variables. Connect timeout 2 s.
- Reconnect after 0.5, 1, 2, 5, then every 10 s. After a loss, requests in flight are answered at once (a tool call with the `connection_lost` text), and new requests wait up to 10 s for the new connection before the offline answer. That covers a service restart: a drain of up to 5 s and a new start. Lines waiting for a connection hold at most 8 MiB, past which stdin waits.
- Offline answers come from `<cache>/mcp-offline.json` when it parses and names the forwarder's build, else from the build's `lib/mcp-offline.json`. Either file is at most 1 MiB. Format 1: `build`, `initialize` and `discover` (each a `result` and its `supported_versions`), `tools_list` (`result` and `modern_result`), `modern_result_fields`, and seven `texts`: `service_down`, `starting`, `unreachable`, `untrusted_endpoint`, `restart_session`, `service_too_old`, `connection_lost`. A3 owns every result in it. A 2026-07-28 request's version is checked first: none is `-32602`, an unsupported one `-32022`. After a `server/discover`, every later request is 2026-07-28, also one without 2026-07-28 fields, until an `initialize` (a client falling back to the legacy era).
- Backpressure both ways: stdin is read only while the socket takes lines, service lines only while stdout takes them, and the forwarder's own replies (offline, at a loss, past the cap) only while stdout takes them. A stdin line over 8 MiB is dropped and reading goes on. A service line over 8 MiB ends that connection. At most 1,024 requests holding at most 8 MiB (IDs and methods) are in flight. One more gets `-32000` with `data: {retryable: true}` at once and is not sent, and stdin keeps being read, so cancellations and the end of the session still arrive.
- `mcp_init` is the client's latest `initialize` or `server/discover`, so a client that fell back from a refused `server/discover` to `initialize` resumes from its `initialize`.
- The process lives until stdin ends, stdout fails or closes, or a signal arrives (exit 0). At the end stdout gets 2 s to take what is queued. A usage problem exits 2 and an internal error 1. Diagnostics are best effort and bounded: a failed stderr write is ignored, and they are dropped while stderr holds 64 KiB unwritten.

## Connection classes

The service decides the class from the bind: `bridge` for mcp mode, `shim` for a shim, and for the CLI `cli-agent` when `context.env` holds any agent marker, else `cli-interactive` when stdin and stdout are TTYs, else `cli-script`. The client never names a class. The class guards well-behaved agents. It is not a security boundary against code of the same user (A6), since such code can fake a TTY or drop the markers.

## Client failures

Reported as `service_unavailable` with A3 3.5's reasons and a fixed `detail` word, never peer text:

| Reason | When | Retryable |
|---|---|---|
| `not_running` | No endpoint, or the connection was refused | no |
| `unreachable` | `EACCES`, `EPERM` (for example inside a sandbox), a connect timeout or another connect failure | no |
| `untrusted_endpoint` | The handshake failed before `Ps` verified, or `Ms` is wrong | no |
| `connection_lost` | Closed or stalled after `Ps` verified | yes |
| `restart_session` | The service refused the client as `client_too_old` | no |
| `service_too_old` | Every other refusal, or a bind result that does not read | no |
