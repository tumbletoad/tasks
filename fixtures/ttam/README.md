# TTAM's recorded conversations

Copied from TTAM's repository, `github.com/tumbletoad/ttam`, at commit `c6b556380b927c9803ea6fe65464206165f83ee0` (`tests/fixtures/json/`), with the fixture home renamed to `/home/mira`, under TTAM's MIT licence in `LICENSE` beside them. Invented data only. The home IDs are still the ones TTAM derived from the original paths; they are opaque, and nothing TTasks does computes or compares them with a path.

Each line is one record of a `ttam query` conversation: `{"from":"ttam","line":…}` a line TTAM wrote, `{"from":"consumer","line":…}` a line the consumer wrote, `{"from":"consumer","close":"input"}`, and `{"from":"ttam","exit":0}`. TTAM's `docs/json-schema.md`, "Recorded conversations", is their reference.

| File | Conversation |
|---|---|
| `query-usage-on.jsonl` | usage queries on: cached and live gets, `busy`, every error, `end` |
| `query-usage-off.jsonl` | TTAM's configuration has usage queries off: a live get is answered `cached` |
| `query-usage-on-first-8.jsonl` | the usage-on conversation of an earlier build of the same schema version, at TTAM commit `a0579c14226893f51dbad08c7198074c14d05519`, before fields were added within it |

The test kit's fake `ttam` (`packages/testkit/src/fakes/ttam.ts`) answers from them. Copy them again, with this commit line and the same rename, when TTAM's schema or query version changes, and keep the first build's usage-on conversation of the new version beside them, named after its commit, so a field added within the version stays optional.
