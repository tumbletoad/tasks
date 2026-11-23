# TTAM's recorded conversations

Copied unchanged from TTAM's repository, `github.com/tumbletoad/ttam`, at commit `e34c42c77442820e669711d4c25ffc248d3468e7` (`tests/fixtures/json/`), under TTAM's MIT licence in `LICENSE` beside them. Invented data only.

Each line is one record of a `ttam query` conversation: `{"from":"ttam","line":…}` a line TTAM wrote, `{"from":"consumer","line":…}` a line the consumer wrote, `{"from":"consumer","close":"input"}`, and `{"from":"ttam","exit":0}`. TTAM's `docs/json-schema.md`, "Recorded conversations", is their reference.

| File | Conversation |
|---|---|
| `query-usage-on.jsonl` | usage queries on: cached and live gets, `busy`, every error, `end` |
| `query-usage-off.jsonl` | TTAM's configuration has usage queries off: a live get is answered `cached` |

The test kit's fake `ttam` (`packages/testkit/src/fakes/ttam.ts`) answers from them. Copy them again, with this commit line, when TTAM's schema or query version changes.
