# Agent Configuration

English | [简体中文](zh-CN/agents.md)

Use this guide to choose which AI coding agents Pilot should collect from and whether sensitive message content should be captured.

## Supported Agent IDs

These IDs identify the supported integrations. Most can be used in installer
options, `agent-control.json`, and `config.json`; shared integrations and output
type differences are called out in the notes.

| Agent | ID | Notes |
|-------|----|-------|
| Claude Code | `claude-code` | Hook integration. |
| Codex | `codex` | Hook integration. |
| Cursor | `cursor` | Hook integration. |
| Cursor CLI | `cursor-cli` | Detected and emitted as `cursor-cli`, but reuses Cursor's installed Hook/input pipeline rather than deploying an independent Hook. Use `cursor-cli` for an output-specific content policy. |
| DeepSeek Harness | `dsh` | User-level YAML patch plugin plus local per-session JSONL polling. Captures native LLM, reasoning, tool, token, and TTFT data. |
| Factory Droid | `droid` | Structural Hook wakeups plus local transcript, settings, and version-gated log collection. Output records use `gen_ai.agent.type=droid`. |
| Hermes Agent | `hermes-agent` | Native directory plugin and local session-file collection. Output records use `gen_ai.agent.type=hermes`. |
| Kiro CLI | `kiro-cli` | Hook integration with delayed local SQLite/session collection. Token usage is not exposed by the source. |
| MiMo Code | `mimo-code` | Plugin injection; captures LLM, tool, and token lifecycle events. |
| OpenClaw | `openclaw` | Plugin injection for OpenClaw 2026.5.12 or later. Captures native LLM, ReAct, tool, token, error, and cancellation events. |
| OpenCode | `opencode` | Plugin injection. |
| Pi Coding Agent | `pi-coding-agent` | Pi Extension injection; captures LLM and tool lifecycle events. |
| Qoder | `qoder` | Hook integration. |
| Qoder CN | `qoder-cn` | Hook integration. |
| Qoder for JetBrains | `qoder-jetbrains` | Detection-only deploy ID. Agent gating uses `qoder` in `agent-control.json`; content policy uses `qoder-idea` in `config.json`. |
| Qoder CLI | `qoder` | Shares the Qoder agent definition and uses hook/session sources. |
| Qoder Work | `qoder-work` | Hook and local data sources. |
| Qoder Work CN | `qoder-work-cn` | Hook and local data sources. |
| Qwen Code CLI | `qwen-code-cli` | Hook integration; parses qwen-code transcript JSONL on Stop. |
| Wukong | `wukong` | Runtime auto-discovery and CLI API polling via local `wukong-cli`; it is not an `agents.d` installer selection. |
| WorkBuddy | `workbuddy` | Structural Hook/file wakeups with a 30-second local transcript polling fallback. Verified on WorkBuddy Desktop 5.2.6 for macOS and 5.3.5.0 for Windows 11. |

The Windows verification used an installed Pilot package, resolved Node from the
installer-pinned `node-bin` with Node absent from `PATH`, and passed strict JSONL
validation against a real WorkBuddy transcript.

Codex collection is transcript-backed. Pilot uses the lightweight
`SessionStart` and `UserPromptSubmit` hooks to discover the effective
`CODEX_HOME`, including task-scoped homes created by orchestrators, and tails
recent rollout files from that session root. `Stop` is retained as a
best-effort wakeup and is not required for directory discovery.

## DeepSeek Harness Collection And Lifecycle

Pilot detects DeepSeek Harness from `~/.dsh` or the `dsh` command. When `dsh`
is enabled, Pilot appends one marked, Pilot-owned block to
`$DSH_HOME/cordis.patch.yml` when `DSH_HOME` is set, otherwise
`~/.dsh/cordis.patch.yml`. That block loads the packaged plugin
from `$PILOT_DATA/plugins/dsh/plugin.mjs`; bytes outside the marked block are
preserved. Start a new DSH process after first enabling or reinstalling the
integration so the host loads the current patch.

The plugin writes append-only native events to
`$PILOT_DATA/logs/dsh/dsh-<session-id>.jsonl`. On POSIX systems, the directory
is mode `0700` and files are mode `0600`. These source files contain the native
message and tool data needed for normalization, so treat them as sensitive;
credential-shaped keys are filtered before writing. `captureMessageContent`
controls normalized output and does not remove content from these source logs.
Pilot derives LLM TTFT from the native request boundary to the first reasoning,
text, or tool-call stream delta and reports it in nanoseconds as
`gen_ai.response.time_to_first_token`.

The normal `agent-control.json` and `config.json` gates use the ID `dsh`.
Disabling collection removes an enable marker first, so an already-loaded
plugin stops writing, then removes only Pilot's marked YAML block. The runtime
watchdog repairs the block while DSH remains enabled. Uninstall performs the
same owned-block cleanup before removing plugin assets and preserves unrelated
YAML content. If the source lacks a request boundary or an output delta, Pilot
omits TTFT instead of fabricating zero.

## Factory Droid Collection And Replay

Pilot's supported Droid contract is transcript schema v2. Live collection and
replay fail closed for another transcript version, and exact log enrichment is
explicitly version-gated to Droid `0.199.0` and `0.200.0`. This prevents a
changed local format from being silently interpreted as a verified schema.

The sources have deliberately different authority:

1. The transcript is authoritative for session, turn, LLM, tool, and visible
   message structure. `user_only` and `llm_only` records are not exported as
   conversation content.
2. The sibling session settings file supplies model/provider fallback and
   aggregate token usage when a precise call-level match is unavailable.
3. Retained Droid `0.199.0` or `0.200.0` logs may enrich a uniquely matched
   call with exact per-call token usage, request/response timing, TTFT, and
   response ID. Pilot does not guess when the join is ambiguous.

Consequently, an old transcript can still be replayed without its log, but
exact historical per-call token counts are guaranteed only while the matching
log records remain. Depending on the available settings baseline, Pilot marks
less precise usage as `single_call_delta`, `turn_aggregate`,
`session_aggregate`, or `missing` instead of assigning an aggregate to an
arbitrary call.

Droid Hooks contain only structural wakeup data; transcript content, tool
arguments, and tool results are read from their source files. Hook deployment
appends Pilot entries and uninstall removes only those entries, preserving
unrelated user Hooks. Polling remains the fallback if a Hook is delayed or
missing. This integration intentionally does not depend on Droid's native OTLP
output: Pilot builds the AgentLoop session/turn/step/LLM/tool topology from the
local sources above.

If Droid message capture is disabled, Pilot removes prompt, completion, tool
argument, and tool result fields. If it is enabled, Droid content still passes
the complete Pilot `mode=all` secret and PII mask plan even when the global
mask setting is `none`.

Inspect complete historical turns without mutation:

```bash
loongsuite-pilot droid replay --session-id <ID> --dry-run
loongsuite-pilot droid replay --from <ISO_TIME> --to <ISO_TIME> --dry-run
```

Dry-run skips incomplete turns and unsupported transcripts, applies the same
content policy plus forced `mode=all` masking, and prints no prompt or tool
content. It also reads `logs/input-state.json` to produce a strict eligibility
summary. A transcript handled by live collection is conservatively excluded as
a whole and reported by `liveProcessedSkipped`; missing, incomplete, pending,
or changed baseline receipts are reported by `unsafeStateSkipped` and
`safetySkipReasons`.

`droid replay --execute` is temporarily disabled and always exits 1 before
source, queue, or ledger access. AgentLoop does not deduplicate a live span and
a replay span that share the same trace/span IDs. Moreover, queue-first remote
success followed by a ledger-write crash can enqueue the same history again.
Safe enablement requires a shared live/replay outbox/receipt that atomically
coordinates source ownership, durable enqueue, and replay acknowledgement.
There is no force override in this release.

The durable queue provides atomic file creation, fsync, deterministic
at-least-once de-duplication, restart recovery, and retry after local spool
acceptance. Retryable network/408/429/5xx failures remain pending, HTTP 400
moves an item to dead-letter, and 401/403 pauses that route. This guarantee
starts when the item reaches `spool/otlp/v1`. Droid live collection commits
its source checkpoint and removes its hook event only after every configured
durable route has accepted the batch locally. If that local write fails, the
transcript offset and hook remain retryable; deterministic IDs make the retry
stable. This source-to-spool acknowledgment applies to Droid, while existing
inputs that have not adopted the same contract can retain an earlier crash
window.

Inspect queue inventory without reading payloads, or explicitly request one
immediate delivery pass:

```bash
loongsuite-pilot failed replay --dry-run
loongsuite-pilot failed replay --execute
```

Old `logs/otlp-failed` JSONL is listed by this command but never automatically
replayed: that legacy format omitted scope, events, and links, so a lossless
migration is impossible.

## OpenClaw Compatibility And Lifecycle

Pilot supports OpenClaw releases `>=2026.5.12`. The plugin package declares
this minimum host version, and OpenClaw checks it against the running host when
loading the plugin. Incompatible hosts skip the plugin with a diagnostic;
Pilot never launches the OpenClaw CLI to determine its version. During
deployment, Pilot adds its plugin package directory to `plugins.load.paths`
and adds this entry to the active OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "loongsuite-pilot-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

`allowConversationAccess` is required for the native conversation lifecycle
hooks that carry per-call messages and usage. Pilot creates a private backup
before migrating a legacy plugin-array configuration. Upgrade also replaces
the previous Pilot single-file load path with the package directory. Uninstall
removes both forms plus Pilot's entry; unrelated plugins and their settings are
preserved.

The injected plugin writes append-only source events below
`~/.loongsuite-pilot/logs/openclaw/`. The directory is mode `0700` and files are
mode `0600` on POSIX systems. Provider errors or cancelled calls can legitimately
have no output message or token usage; Pilot reports the native finish reason
and timing without inventing content or zero token counts.

## Choose Agents During Installation

Use `--agents` to skip the interactive selection step:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor,dsh"
```

The installer still checks whether each selected agent exists on the machine before deploying collection capabilities.

## Enable Or Disable Agents After Installation

Use `~/.loongsuite-pilot/agent-control.json` for simple admission control:

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "dsh": "on",
    "qoder": "off"
  }
}
```

| Mode | Meaning |
|------|---------|
| `on` | Force-enable the agent when its data source exists. |
| `off` | Disable the agent. |
| `auto` | Use default auto-detection behavior. |

Restart Pilot after changing this file:

```bash
loongsuite-pilot restart
```

## Configure Content Capture Per Agent

Use `config.json` when you need to control message content capture:

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "dsh": { "enabled": true, "captureMessageContent": false },
    "droid": { "enabled": true, "captureMessageContent": false },
    "openclaw": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Set to `false` to disable the agent from config. |
| `captureMessageContent` | Set to `false` to avoid collecting full prompts, completions, tool arguments, and tool results where the integration supports that policy. |
| `multimodal.uploadMode` | Multimodal upload policy. `none` (default) disables; `input` / `tool` / `output` / `both` select conversion surfaces. See [Multimodal Collection](multimodal.md). |

For sensitive environments, pair `captureMessageContent: false` with [Data Masking](masking.md). To collect multimodal data, see [Multimodal Collection](multimodal.md) (images only; `codex` only today).
For sensitive environments, pair `captureMessageContent: false` with [Data Masking](masking.md).
For Droid, enabling content never bypasses the forced complete `mode=all` mask plan.

## Verify Agent Collection

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

If an expected agent is not collecting:

- Confirm the agent is installed and has been used at least once.
- Confirm the agent ID is not set to `off` in `agent-control.json`.
- Confirm `config.json` does not set the agent to `"enabled": false`.
- Restart Pilot after configuration changes.
