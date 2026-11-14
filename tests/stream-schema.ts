// The shape of the recorded stream fixtures (fixtures/streams/, A7 3.7 M0.11 and N05). One schema
// serves two sides:
// - the lab's sanitiser (spikes/m0/runs/sanitise.ts) writes every fixture value by it, and
// - the structural check (tests/stream-content.ts) asserts that every value in a committed fixture
//   is one its treatment can produce. That check, not the text scan, is what keeps private data
//   out of the fixtures: a field never lets an observed value through because the field is known.
//
// Every allow-listed field has exactly one treatment, and each treatment fixes its output:
//   enum      a value from an explicit vocabulary; anything else (any type) becomes "unknown-value"
//   bool      a boolean; anything else becomes null
//   int       an integer in a fixed range (exit codes, HTTP status, turn counts); else null
//   null      a field only ever seen as null; any other value becomes null
//   const     one fixed fixture value (setting names, provider, inference metadata, account state)
//   name      a synthetic name, consistent within one stream (models, rate-limit windows)
//   path      a fixture path in the stream's OS style, consistent within one stream
//   version   kept only when it matches a strict version pattern, else "0.0.0"
//   id        a synthetic ID by the field's meaning, consistent within one stream; never any part
//             of the input, whatever its type
//   time      the fixed series 2026-01-01T00:00:00.000Z, +1 s, ... (any input type)
//   epoch     the fixed series 1767225600, +3600, ... (any input type)
//   text      "Fixture text." ("" stays ""): every model- or tool-written text
//   error     "Fixture error message (<class>)." with a class from a fixed list
//   signature "fixture-signature" ("" stays "")
//   number    one fixture number per kind of measure (tokens, milliseconds, dollars, ...)
//   list      a list rebuilt from a small fixture vocabulary: never the observed list
// Containers: an object with named fields (any other field is dropped), a map whose keys are
// data (keys become synthetic keys), an array, a variant chosen by a tag field from a fixed set,
// or one spec per JSON type. An event type outside the schema becomes {"type":"unknown-event"}.

export type CliKind = "claude-print" | "codex-exec";
export type Os = "windows" | "linux";

// ---------------------------------------------------------------------------------------------
// Vocabularies.
export const VOCAB = {
  server: ["tasks"],
  "server-label": ["tasks", "tasks-probe"],
  tool: [
    "ToolSearch",
    "mcp__tasks__probe_echo",
    "mcp__tasks__probe_marked",
    "mcp__tasks__probe_plain",
  ],
  "probe-tool": ["probe_echo", "probe_marked", "probe_plain"],
  "mcp-status": ["connected", "failed", "pending", "needs-auth", "disabled"],
  "mcp-source": ["dynamic", "project", "user", "local"],
  "permission-mode": [
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
  ],
  role: ["assistant", "user"],
  "message-type": ["message"],
  "caller-type": ["direct"],
  "iteration-type": ["message"],
  "stop-reason": ["end_turn", "tool_use", "stop_sequence", "max_tokens", "pause_turn", "refusal"],
  "terminal-reason": ["completed", "aborted_streaming", "aborted_tools", "max_turns", "api_error"],
  "result-subtype": [
    "success",
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ],
  "api-error": [
    "model_not_found",
    "authentication_failed",
    "billing_error",
    "rate_limit",
    "invalid_request",
    "server_error",
    "unknown",
  ],
  "permission-decision": ["accept", "reject", "ask"],
  "permission-source": ["config", "user", "hook", "session", "policy"],
  "permission-reason": ["mode", "rule", "hook", "user", "classifier"],
  "non-execution-kind": ["user-rejected", "hook-blocked", "permission-denied", "interrupted"],
  "item-status": ["in_progress", "completed", "failed", "declined"],
  "change-kind": ["add", "delete", "update"],
} as const satisfies Record<string, readonly string[]>;
export type VocabName = keyof typeof VOCAB;

/** A line of the raw stream that was not JSON, or not an object, as it stands in a fixture. */
export const NOT_JSON_LINE = "fixture: not JSON";
export const NOT_OBJECT_LINE = "fixture: not an object";

/** The value an enum gets when the input is outside its vocabulary (or not a string). */
export const UNKNOWN_VALUE = "unknown-value";
/** An event whose type (or Claude `system` subtype) the schema does not know. */
export const UNKNOWN_EVENT = { type: "unknown-event" } as const;

/** Error classes for error text, from a fixed list: the fixture says the class, never the text. */
export const ERROR_CLASSES = [
  "no input",
  "model",
  "interrupted",
  "max turns",
  "approval",
  "rate limit",
  "auth",
  "tool",
  "other",
] as const;

export function errorClassOf(text: string): (typeof ERROR_CLASSES)[number] {
  const classes: [RegExp, (typeof ERROR_CLASSES)[number]][] = [
    [/input must be provided|no prompt/i, "no input"],
    [/model/i, "model"],
    [/interrupt|cancel|abort/i, "interrupted"],
    [/max.?turns|maximum number of turns/i, "max turns"],
    [/approval/i, "approval"],
    [/rate.?limit|usage limit|429/i, "rate limit"],
    [/not logged in|login|unauthor|401/i, "auth"],
    [/mcp|server|tool/i, "tool"],
  ];
  for (const [re, label] of classes) if (re.test(text)) return label;
  return "other";
}

// ---------------------------------------------------------------------------------------------
// Fixture values.
export const FIXTURE_TEXT = "Fixture text.";
export const FIXTURE_SIGNATURE = "fixture-signature";
export const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
export const BASE_EPOCH = 1_767_225_600;
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[a-z0-9]{1,12})?$/;
export const VERSION_PLACEHOLDER = "0.0.0";

/** Fixture numbers: the type stays, the measurement goes. */
export const NUMBERS = {
  tokens: 100,
  requests: 1,
  ms: 1000,
  usd: 0.001,
  limit: 1000,
  ratio: 0.5,
  count: 10,
} as const;
export type NumberKind = keyof typeof NUMBERS;

/** Fixed fixture values. */
export const CONSTS = {
  setting: "fixture-setting",
  flag: false,
  provider: "fixture-provider",
  "cost-basis": "fixture-basis",
  inference: "fixture-inference",
  "account-state": "fixture_state",
  "key-source": "fixture-source",
  "display-name": "fixture-display-name",
} as const;
export type ConstKind = keyof typeof CONSTS;

export type IdKind = "session" | "event" | "thread" | "message" | "tool-use" | "request" | "item";
const pad = (n: number, w: number) => String(n).padStart(w, "0");
export function syntheticId(kind: IdKind, n: number): string {
  switch (kind) {
    case "session":
    case "event":
    case "thread":
      return `00000000-0000-4000-8000-${pad(n, 12)}`;
    case "message":
      return `msg_fixture${pad(n, 4)}`;
    case "tool-use":
      return `toolu_fixture${pad(n, 4)}`;
    case "request":
      return `req_fixture${pad(n, 4)}`;
    case "item":
      return `item_${String(n)}`;
  }
}
const ID_PATTERN: Record<IdKind, RegExp> = {
  session: /^00000000-0000-4000-8000-\d{12}$/,
  event: /^00000000-0000-4000-8000-\d{12}$/,
  thread: /^00000000-0000-4000-8000-\d{12}$/,
  message: /^msg_fixture\d{4}$/,
  "tool-use": /^toolu_fixture\d{4}$/,
  request: /^req_fixture\d{4}$/,
  item: /^item_\d{1,6}$/,
};

/** Synthetic names, consistent within one stream. Some protocol values stay as themselves. */
export type NameTable = "model" | "window";
export const NAME_KEEP: Record<NameTable, readonly string[]> = {
  model: ["<synthetic>"],
  window: [],
};
export function syntheticName(table: NameTable, n: number): string {
  const base = table === "model" ? "fixture-model" : "fixture_window";
  return n === 1 ? base : `${base}${table === "model" ? "-" : "_"}${String(n)}`;
}
const NAME_PATTERN: Record<NameTable, RegExp> = {
  model: /^fixture-model(?:-\d{1,4})?$/,
  window: /^fixture_window(?:_\d{1,4})?$/,
};

/** Keys of maps whose keys are data. */
export type KeyKind = "model" | "window" | "tool-use" | "memory" | "agent-type";
export function syntheticKey(kind: "memory" | "agent-type", n: number): string {
  return `fixture-${kind}-${String(n)}`;
}
function keyOk(kind: KeyKind, key: string): boolean {
  switch (kind) {
    case "model":
    case "window":
      return NAME_PATTERN[kind].test(key) || NAME_KEEP[kind].includes(key);
    case "tool-use":
      return ID_PATTERN["tool-use"].test(key);
    case "memory":
    case "agent-type":
      return new RegExp(`^fixture-${kind}-\\d{1,4}$`).test(key);
  }
}

/** A fixture path: `C:\fixture\<leaf>` on Windows, `/fixture/<leaf>` on Linux. */
export function fixturePath(os: Os, leaf: string): string {
  return os === "windows" ? `C:\\fixture\\${leaf}` : `/fixture/${leaf}`;
}
export function pathLeaf(n: number): string {
  return n === 1 ? "work" : `path-${String(n)}`;
}
function pathOk(os: Os, v: string): boolean {
  if (v === "") return true;
  const leaf = /^(?:work|path-\d{1,4}|plugin|extra)$/;
  const prefix = fixturePath(os, "");
  return v.startsWith(prefix) && leaf.test(v.slice(prefix.length));
}

/** Lists rebuilt from a fixture vocabulary: invented entries plus known entries the input had. */
export type ListName =
  | "tools"
  | "matches"
  | "capabilities"
  | "slash-commands"
  | "terminal-slash-commands"
  | "skills"
  | "agents"
  | "plugins"
  | "directories"
  | "none";
const PROBE_TOOLS = VOCAB.tool.filter((t) => t.startsWith("mcp__tasks__"));
/** Field names of list elements that are objects; the inventory shows any other as a placeholder. */
export const LIST_ELEMENT_FIELDS: Partial<Record<ListName, readonly string[]>> = {
  plugins: ["name", "path", "source"],
};
export function listVocabulary(
  name: ListName,
  os: Os,
): { invented: readonly unknown[]; keep: readonly string[] } {
  switch (name) {
    case "tools":
      return { invented: ["FixtureToolA", "FixtureToolB"], keep: PROBE_TOOLS };
    case "matches":
      return { invented: [], keep: PROBE_TOOLS };
    case "capabilities":
      return { invented: ["fixture_capability_v1"], keep: [] };
    case "slash-commands":
      return { invented: ["fixture-command-a", "fixture-command-b"], keep: [] };
    case "terminal-slash-commands":
      return { invented: ["fixture-command-b"], keep: [] };
    case "skills":
      return { invented: ["fixture-skill-a"], keep: [] };
    case "agents":
      return { invented: ["fixture-agent-a"], keep: [] };
    case "plugins":
      return {
        invented: [
          {
            name: "fixture-plugin-a",
            path: fixturePath(os, "plugin"),
            source: "fixture-marketplace",
          },
        ],
        keep: [],
      };
    case "directories":
      return { invented: [fixturePath(os, "extra")], keep: [] };
    case "none":
      return { invented: [], keep: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// Specs.
export type Leaf =
  | { t: "tag" } // the event or variant tag that selected this spec: kept
  | { t: "enum"; vocab: VocabName }
  | { t: "bool" }
  | { t: "int"; min: number; max: number }
  | { t: "null" }
  | { t: "const"; kind: ConstKind }
  | { t: "name"; table: NameTable }
  | { t: "path" }
  | { t: "version" }
  | { t: "id"; kind: IdKind }
  | { t: "time" }
  | { t: "epoch" }
  | { t: "text" }
  | { t: "error" }
  | { t: "signature" }
  | { t: "number"; kind: NumberKind }
  | { t: "list"; list: ListName };

export type Spec =
  | Leaf
  | { obj: Record<string, Spec> }
  | { map: Spec; key: KeyKind }
  | { arr: Spec; probeOnly?: true }
  | { by: string; cases: Record<string, Record<string, Spec>> }
  | { oneOf: { string?: Spec; array?: Spec; object?: Spec } };

export const isLeaf = (s: Spec): s is Leaf => "t" in s;

const TAG: Leaf = { t: "tag" };
const B: Leaf = { t: "bool" };
const NUL: Leaf = { t: "null" };
const PATH: Leaf = { t: "path" };
const VER: Leaf = { t: "version" };
const TIME: Leaf = { t: "time" };
const EPOCH: Leaf = { t: "epoch" };
const TEXT: Leaf = { t: "text" };
const ERR: Leaf = { t: "error" };
const SIG: Leaf = { t: "signature" };
const e = (vocab: VocabName): Leaf => ({ t: "enum", vocab });
const int = (min: number, max: number): Leaf => ({ t: "int", min, max });
const c = (kind: ConstKind): Leaf => ({ t: "const", kind });
const id = (kind: IdKind): Leaf => ({ t: "id", kind });
const n = (kind: NumberKind): Leaf => ({ t: "number", kind });
const list = (name: ListName): Leaf => ({ t: "list", list: name });
const each = (spec: Spec, ...names: string[]): Record<string, Spec> =>
  Object.fromEntries(names.map((x) => [x, spec]));

const TOK = n("tokens");
const MS = n("ms");
const COUNT = int(0, 100_000);
const cacheCreation: Spec = {
  obj: each(TOK, "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"),
};
const claudeUsage: Spec = {
  obj: {
    ...each(
      TOK,
      "input_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "output_tokens",
    ),
    cache_creation: cacheCreation,
    server_tool_use: { obj: each(n("requests"), "web_search_requests", "web_fetch_requests") },
    output_tokens_details: { obj: each(TOK, "thinking_tokens") },
    ...each(c("inference"), "service_tier", "inference_geo", "speed"),
    fallback_credit: NUL,
    iterations: {
      arr: {
        obj: {
          ...each(
            TOK,
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
          ),
          cache_creation: cacheCreation,
          type: e("iteration-type"),
        },
      },
    },
  },
};
const modelUsage: Spec = {
  key: "model",
  map: {
    obj: {
      ...each(
        TOK,
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "thinkingTokens",
        "cacheCreationEphemeral5mInputTokens",
        "cacheCreationEphemeral1hInputTokens",
      ),
      webSearchRequests: n("requests"),
      costUSD: n("usd"),
      ...each(n("limit"), "contextWindow", "maxOutputTokens"),
      canonicalModel: { t: "name", table: "model" },
      provider: c("provider"),
      costBasis: c("cost-basis"),
    },
  },
};
const toolInput: Spec = { obj: { text: TEXT, query: TEXT, max_results: n("count") } };
const innerBlock: Spec = {
  by: "type",
  cases: { text: { text: TEXT }, tool_reference: { tool_name: e("tool") } },
};
const claudeBlock: Spec = {
  by: "type",
  cases: {
    text: { text: TEXT },
    thinking: { thinking: TEXT, signature: SIG },
    tool_use: {
      id: id("tool-use"),
      name: e("tool"),
      input: toolInput,
      caller: { obj: { type: e("caller-type") } },
    },
    tool_result: {
      tool_use_id: id("tool-use"),
      content: { oneOf: { string: TEXT, array: { arr: innerBlock } } },
      is_error: B,
    },
  },
};
const subagentStats: Spec = {
  obj: {
    ...each(
      COUNT,
      "spawned",
      "started_in_background",
      "max_depth",
      "spawned_by_subagents",
      "completed",
      "failed",
    ),
    requested: { obj: each(COUNT, "background", "foreground", "unset") },
    killed: { obj: each(COUNT, "parent", "user", "system") },
    refused: { obj: each(COUNT, "depth_limit", "concurrency_limit", "budget") },
    by_type: { key: "agent-type", map: COUNT },
  },
};
const ids = { session_id: id("session"), uuid: id("event") };

/** Claude Code stream-json (2.1.322, observed 2026-11-12). Key: `type`, or `system/<subtype>`. */
export const CLAUDE: Record<string, Spec> = {
  "system/init": {
    obj: {
      type: TAG,
      subtype: TAG,
      ...ids,
      ...each(PATH, "cwd", "original_cwd", "messaging_socket_path", "powershell_path"),
      tools: list("tools"),
      mcp_servers: {
        arr: { obj: { name: e("server"), status: e("mcp-status"), source: e("mcp-source") } },
        probeOnly: true,
      },
      model: { t: "name", table: "model" },
      permissionMode: e("permission-mode"),
      slash_commands: list("slash-commands"),
      terminal_slash_commands: list("terminal-slash-commands"),
      apiKeySource: c("key-source"),
      claude_code_version: VER,
      agents: list("agents"),
      skills: list("skills"),
      plugins: list("plugins"),
      capabilities: list("capabilities"),
      memory_paths: { key: "memory", map: PATH },
      additional_directories: list("directories"),
      ...each(
        c("setting"),
        "output_style",
        "fast_mode_state",
        "fast_mode_disabled_reason",
        "view_mode",
      ),
      ...each(
        c("flag"),
        "analytics_disabled",
        "product_feedback_disabled",
        "per_turn_effort_active",
        "ultrathink_available",
        "ultrathink_typed_raises",
      ),
    },
  },
  "system/thinking_tokens": {
    obj: {
      type: TAG,
      subtype: TAG,
      ...each(TOK, "estimated_tokens", "estimated_tokens_delta"),
      ...ids,
    },
  },
  assistant: {
    obj: {
      type: TAG,
      message: {
        obj: {
          model: { t: "name", table: "model" },
          id: id("message"),
          type: e("message-type"),
          role: e("role"),
          content: { arr: claudeBlock },
          stop_reason: e("stop-reason"),
          stop_sequence: TEXT,
          usage: claudeUsage,
          input_transformations: list("none"),
          ...each(NUL, "container", "stop_details", "diagnostics", "context_management"),
        },
      },
      parent_tool_use_id: id("tool-use"),
      ...ids,
      timestamp: TIME,
      request_id: id("request"),
      wire_tool_inputs: { key: "tool-use", map: toolInput },
      tool_use_meta: {
        arr: {
          obj: {
            id: id("tool-use"),
            display_name: c("display-name"),
            server_display_name: e("server-label"),
            tool_name: e("probe-tool"),
          },
        },
      },
      thinking_duration_ms: MS,
      thinking_display: c("setting"),
      error: e("api-error"),
      is_api_error_message: B,
      api_error_status: int(100, 599),
    },
  },
  user: {
    obj: {
      type: TAG,
      message: {
        obj: {
          role: e("role"),
          content: { oneOf: { string: TEXT, array: { arr: claudeBlock } } },
        },
      },
      parent_tool_use_id: id("tool-use"),
      ...ids,
      timestamp: TIME,
      tool_use_result: {
        oneOf: {
          string: TEXT,
          object: {
            obj: {
              matches: list("matches"),
              query: TEXT,
              total_deferred_tools: n("count"),
              content: { arr: innerBlock },
              structuredContent: NUL,
              _meta: {
                obj: {
                  "io.modelcontextprotocol/serverInfo": {
                    obj: { name: e("server-label"), version: VER },
                  },
                },
              },
            },
          },
        },
      },
      tool_result_meta: {
        arr: {
          obj: {
            id: id("tool-use"),
            permission_decision: {
              obj: {
                decision: e("permission-decision"),
                source: e("permission-source"),
                reason_type: e("permission-reason"),
              },
            },
            non_execution_kind: e("non-execution-kind"),
          },
        },
      },
    },
  },
  rate_limit_event: {
    obj: {
      type: TAG,
      rate_limit_info: {
        obj: {
          ...each(c("account-state"), "status", "overageStatus", "overageDisabledReason"),
          resetsAt: EPOCH,
          rateLimitType: { t: "name", table: "window" },
          ...each(n("ratio"), "utilization", "surpassedThreshold"),
          ...each(c("flag"), "isUsingOverage", "overageEnabled"),
          unifiedWindows: {
            key: "window",
            map: {
              obj: {
                ...each(n("ratio"), "utilization", "surpassedThreshold"),
                resetsAt: EPOCH,
                status: c("account-state"),
              },
            },
          },
        },
      },
      ...ids,
    },
  },
  result: {
    obj: {
      type: TAG,
      subtype: e("result-subtype"),
      is_error: B,
      api_error_status: int(100, 599),
      result: TEXT,
      errors: { arr: ERR },
      stop_reason: e("stop-reason"),
      terminal_reason: e("terminal-reason"),
      ...ids,
      ...each(
        MS,
        "duration_ms",
        "duration_api_ms",
        "ttft_ms",
        "ttft_stream_ms",
        "time_to_request_ms",
        "first_content_frame_ms",
      ),
      ...each(int(0, 1000), "num_turns", "safety_stops", "queued_turn_count", "result_index"),
      total_cost_usd: n("usd"),
      usage: claudeUsage,
      modelUsage,
      model_usage_since_last_result: modelUsage,
      permission_denials: {
        arr: { obj: { tool_name: e("tool"), tool_use_id: id("tool-use"), tool_input: toolInput } },
      },
      ...each(c("setting"), "fast_mode_state", "fast_mode_disabled_reason"),
      subagent_stats: subagentStats,
      credential_expires_at: TIME,
    },
  },
};

// Codex exec --json (codex-cli 0.167.2, observed 2026-11-12; item types from A4 3.11.4).
const errorObj: Spec = { obj: { message: ERR } };
const ITEM = id("item");
const STATUS = e("item-status");
const codexItem: Spec = {
  by: "type",
  cases: {
    agent_message: { id: ITEM, text: TEXT },
    reasoning: { id: ITEM, text: TEXT },
    mcp_tool_call: {
      id: ITEM,
      server: e("server"),
      tool: e("probe-tool"),
      arguments: toolInput,
      result: {
        oneOf: { object: { obj: { content: { arr: innerBlock }, structured_content: NUL } } },
      },
      error: { oneOf: { object: errorObj, string: ERR } },
      status: STATUS,
    },
    command_execution: {
      id: ITEM,
      command: TEXT,
      aggregated_output: TEXT,
      exit_code: int(-2_147_483_648, 4_294_967_295),
      status: STATUS,
    },
    file_change: {
      id: ITEM,
      changes: { arr: { obj: { path: PATH, kind: e("change-kind") } } },
      status: STATUS,
    },
    web_search: { id: ITEM, query: TEXT },
    todo_list: { id: ITEM, items: { arr: { obj: { text: TEXT, completed: B } } } },
    error: { id: ITEM, message: ERR },
  },
};
const itemEvent: Spec = { obj: { type: TAG, item: codexItem } };
/** Codex exec --json. Key: `type`. */
export const CODEX: Record<string, Spec> = {
  "thread.started": { obj: { type: TAG, thread_id: id("thread") } },
  "turn.started": { obj: { type: TAG } },
  "turn.completed": {
    obj: {
      type: TAG,
      usage: {
        obj: each(
          TOK,
          "input_tokens",
          "cached_input_tokens",
          "cache_write_input_tokens",
          "output_tokens",
          "reasoning_output_tokens",
        ),
      },
    },
  },
  "turn.failed": { obj: { type: TAG, error: errorObj } },
  error: { obj: { type: TAG, message: ERR } },
  "item.started": itemEvent,
  "item.updated": itemEvent,
  "item.completed": itemEvent,
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The spec of one raw or fixture event, or undefined for an event type the schema does not know. */
export function specFor(cli: CliKind, event: Record<string, unknown>): Spec | undefined {
  const type = event["type"];
  if (typeof type !== "string") return undefined;
  if (cli === "codex-exec") return Object.hasOwn(CODEX, type) ? CODEX[type] : undefined;
  if (type === "system") {
    const sub = event["subtype"];
    const key = `system/${String(sub)}`;
    return typeof sub === "string" && Object.hasOwn(CLAUDE, key) ? CLAUDE[key] : undefined;
  }
  // The `system/<subtype>` keys are reached through `system` only.
  return !type.includes("/") && Object.hasOwn(CLAUDE, type) ? CLAUDE[type] : undefined;
}

/**
 * The key of an event for inventories and results, from schema values only: `type`,
 * `type/subtype` (Claude), `type:item.type` (Codex), or `unknown-event`. A subtype or item type
 * outside its vocabulary shows as `unknown-value`; nothing of the input passes.
 */
export function eventKeyOf(cli: CliKind, event: unknown): string {
  if (!isObject(event)) return UNKNOWN_EVENT.type;
  const spec = specFor(cli, event);
  if (spec === undefined) return UNKNOWN_EVENT.type;
  const type = event["type"] as string;
  if (cli === "claude-print") {
    if (type === "system") return `system/${event["subtype"] as string}`;
    if (type === "result") {
      const sub = event["subtype"];
      const known = (VOCAB["result-subtype"] as readonly string[]).includes(String(sub));
      return `result/${typeof sub === "string" && known ? sub : UNKNOWN_VALUE}`;
    }
    return type;
  }
  const item = event["item"];
  if (!isObject(item)) return type;
  const t = item["type"];
  const cases = (codexItem as { cases: Record<string, unknown> }).cases;
  return `${type}:${typeof t === "string" && Object.hasOwn(cases, t) ? t : UNKNOWN_VALUE}`;
}

/** Every field path a spec allows, in the inventory's notation (`a.b`, `a[]`, `a.<map-key>`). */
export function allowedPaths(spec: Spec, prefix = "", out = new Set<string>()): Set<string> {
  if (prefix !== "") out.add(prefix);
  if (isLeaf(spec)) {
    // A rebuilt list: the inventory still records the element types of the observed list.
    if (spec.t === "list") {
      out.add(`${prefix}[]`);
      for (const f of LIST_ELEMENT_FIELDS[spec.list] ?? []) out.add(`${prefix}[].${f}`);
    }
    return out;
  }
  const dot = prefix === "" ? "" : `${prefix}.`;
  if ("obj" in spec)
    for (const [k, s] of Object.entries(spec.obj)) allowedPaths(s, `${dot}${k}`, out);
  else if ("map" in spec) allowedPaths(spec.map, `${dot}<map-key>`, out);
  else if ("arr" in spec) allowedPaths(spec.arr, `${prefix}[]`, out);
  else if ("by" in spec) {
    out.add(`${dot}${spec.by}`);
    for (const fields of Object.values(spec.cases)) {
      for (const [k, s] of Object.entries(fields)) allowedPaths(s, `${dot}${k}`, out);
    }
  } else for (const s of Object.values(spec.oneOf)) allowedPaths(s, prefix, out);
  return out;
}

/** The inventory's treatment names: what the sanitiser really did with a value. */
export const TREATMENTS = [
  "container",
  "kept",
  "placeholder",
  "fixture-value",
  "synthetic-name",
  "fixture-path",
  "synthetic-id",
  "series-time",
  "fixture-text",
  "fixture-error-text",
  "fixture-number",
  "rebuilt-list",
  "rebuilt-without-other-servers",
  "synthetic-key",
  "dropped",
] as const;
export type Treatment = (typeof TREATMENTS)[number];

// ---------------------------------------------------------------------------------------------
// The structural check: every value of a fixture event is one its treatment can produce.

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function leafOk(leaf: Leaf, v: unknown, os: Os): boolean {
  if (v === null) return true;
  switch (leaf.t) {
    case "tag":
      return typeof v === "string";
    case "enum":
      return (
        v === UNKNOWN_VALUE ||
        (typeof v === "string" && (VOCAB[leaf.vocab] as readonly string[]).includes(v))
      );
    case "bool":
      return typeof v === "boolean";
    case "int":
      return Number.isInteger(v) && (v as number) >= leaf.min && (v as number) <= leaf.max;
    case "null":
      return false;
    case "const":
      return v === CONSTS[leaf.kind];
    case "name":
      return (
        typeof v === "string" &&
        (NAME_PATTERN[leaf.table].test(v) || NAME_KEEP[leaf.table].includes(v))
      );
    case "path":
      return typeof v === "string" && pathOk(os, v);
    case "version":
      return typeof v === "string" && VERSION.test(v);
    case "id":
      return typeof v === "string" && ID_PATTERN[leaf.kind].test(v);
    case "time": {
      if (typeof v !== "string") return false;
      const t = Date.parse(v);
      return (
        Number.isFinite(t) &&
        new Date(t).toISOString() === v &&
        t >= BASE_TIME &&
        (t - BASE_TIME) % 1000 === 0 &&
        t - BASE_TIME < 100_000_000
      );
    }
    case "epoch":
      return (
        Number.isInteger(v) &&
        (v as number) >= BASE_EPOCH &&
        ((v as number) - BASE_EPOCH) % 3600 === 0 &&
        (v as number) - BASE_EPOCH < 3600 * 100_000
      );
    case "text":
      return v === "" || v === FIXTURE_TEXT;
    case "error":
      return (
        typeof v === "string" &&
        ERROR_CLASSES.some((cls) => v === `Fixture error message (${cls}).`)
      );
    case "signature":
      return v === "" || v === FIXTURE_SIGNATURE;
    case "number":
      return v === NUMBERS[leaf.kind];
    case "list": {
      if (!Array.isArray(v)) return false;
      const { invented, keep } = listVocabulary(leaf.list, os);
      return v.every(
        (x) => invented.some((i) => equal(i, x)) || (typeof x === "string" && keep.includes(x)),
      );
    }
  }
}

function describe(path: string): string {
  return path === "" ? "(event)" : path;
}

function check(spec: Spec, v: unknown, path: string, os: Os, out: string[]): void {
  if (isLeaf(spec)) {
    if (!leafOk(spec, v, os)) out.push(`${describe(path)}: not a ${spec.t} value of the fixtures`);
    return;
  }
  if (v === null) return;
  if ("oneOf" in spec) {
    const t = Array.isArray(v) ? "array" : typeof v;
    const sub = t === "string" || t === "array" || t === "object" ? spec.oneOf[t] : undefined;
    if (sub === undefined) out.push(`${describe(path)}: unexpected JSON type`);
    else check(sub, v, path, os, out);
    return;
  }
  if ("arr" in spec) {
    if (!Array.isArray(v)) {
      out.push(`${describe(path)}: expected an array`);
      return;
    }
    for (const x of v) {
      check(spec.arr, x, `${path}[]`, os, out);
      if (spec.probeOnly === true && !(isObject(x) && x["name"] === "tasks")) {
        out.push(`${path}[]: only the probe server may be listed`);
      }
    }
    return;
  }
  if (!isObject(v)) {
    out.push(`${describe(path)}: expected an object`);
    return;
  }
  const dot = path === "" ? "" : `${path}.`;
  if ("map" in spec) {
    for (const [k, x] of Object.entries(v)) {
      if (!keyOk(spec.key, k)) out.push(`${dot}<map-key>: not a synthetic ${spec.key} key`);
      check(spec.map, x, `${dot}<map-key>`, os, out);
    }
    return;
  }
  let fields: Record<string, Spec>;
  if ("by" in spec) {
    const tag = v[spec.by];
    if (tag === UNKNOWN_VALUE) {
      if (Object.keys(v).length !== 1)
        out.push(`${dot}${spec.by}: an unknown variant keeps its tag only`);
      return;
    }
    if (typeof tag !== "string" || !Object.hasOwn(spec.cases, tag)) {
      out.push(`${dot}${spec.by}: unknown variant`);
      return;
    }
    fields = { [spec.by]: TAG, ...(spec.cases[tag] as Record<string, Spec>) };
  } else fields = spec.obj;
  for (const [k, x] of Object.entries(v)) {
    const s = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (s === undefined) out.push(`${dot}<field>: a field the schema does not allow`);
    else check(s, x, `${dot}${k}`, os, out);
  }
}

/**
 * The structural findings for one fixture event (an empty list means it conforms). Field names in
 * findings are schema names or placeholders, never a name taken from the event.
 */
export function checkEventStructure(cli: CliKind, os: Os, event: unknown): string[] {
  if (!isObject(event)) return ["(line): not a JSON object"];
  if (equal(event, UNKNOWN_EVENT)) return [];
  const spec = specFor(cli, event);
  if (spec === undefined) return ["(event): an event type the schema does not know"];
  const out: string[] = [];
  check(spec, event, "", os, out);
  return out;
}
