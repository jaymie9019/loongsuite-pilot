# Droid to AgentLoop diagnostics

Use this reference for missing sessions, wrong topology/model/provider/token data, stuck queues, or unclear upload status.

## Evidence layers

Keep the conclusion in this order:

| Layer | Truth source | What it proves |
|---|---|---|
| 1. Droid source | `~/.factory/sessions/**/*.jsonl`, sibling settings, version-gated Droid logs, Pilot-owned hook hints | Droid produced source data and a terminal boundary |
| 2. Pilot input | `logs/input-state.json`, `logs/output/droid-*.jsonl`, service log | Pilot parsed and accepted the source range locally |
| 3. Durable export | `spool/otlp/v1`, `loongsuite-pilot failed replay --dry-run --json` | An OTLP route durably accepted the batch and whether it remains pending/dead-lettered |
| 4. AgentLoop | Exact session ID and event time window in the configured workspace | The intended remote workspace indexed and rendered the session |

Checkpoint advancement means every configured durable OTLP route returned a local fsync acknowledgement. It does not by itself prove AgentLoop HTTP acceptance. A pending item is removed only after exporter success, but there is no persistent remote receipt; `pending=0` can also mean nothing was enqueued. Always verify the exact cloud session when access is available.

## Safe first pass

```bash
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot failed replay --dry-run --json
```

`info` must redact credentials. If it does not, stop and fix redaction before sharing output.

For a user-provided session ID, use the content-free helper rather than printing matching JSONL lines:

```bash
SESSION_ID="<session-id>"
node scripts/session-evidence.mjs "$SESSION_ID"
```

Resolve `scripts/session-evidence.mjs` relative to this Skill directory. It reports event counts, model/provider, usage totals, trace/turn IDs, offsets, file sizes, and timestamps without prompt or tool content. It proves only local source/checkpoint/output; run durable inventory and verify AgentLoop separately.

The normal Droid integration installs one managed hook for each of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, and `SessionEnd`. Missing hooks increase latency, but transcript polling remains a fallback; absence of one hook is not proof that collection stopped.

When checkpoint/output disagree, inspect input metrics without exposing `user_id`:

```bash
jq -c '
  select(.label.input_name == "droid-transcript")
  | {time: .__time__, input: .label.input_name,
     in_events_total, out_events_total, out_failed_events_total,
     in_size_bytes, last_poll_time, start_time}
' ~/.loongsuite-pilot/logs/metric_alarm/pilot-input-metrics.jsonl | tail -n 1
```

Read rotated service logs through a safe projection; do not print path, transcriptPath, endpoint, hostname, or raw error fields:

```bash
jq -c '
  select(.tag == "DroidInput" or .id == "droid-transcript"
         or .inputId == "droid-transcript")
  | {time, level, tag, msg, id, inputId, count, httpStatus, errorType}
' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log*
```

The base daemon log may be empty while dated/rotated files contain the evidence. Absence of an `Exporting N spans` line is not proof of no export because small batches are not always logged.

## Expected Droid structure

One visible user prompt is one turn and one trace. A typical tool turn is:

```text
ENTRY
└─ AGENT
   ├─ STEP
   │  ├─ LLM
   │  └─ TOOL
   └─ STEP
      └─ LLM
```

Validate all non-root parent links, not just span counts. Trace and span IDs are deterministic so local retry and safe reconstruction use the same IDs, but deterministic IDs are not permission to replay into AgentLoop.

## Classification

- **No transcript:** Droid did not create the session where Pilot expects it, or the session ID/path is wrong. Check Droid version and Factory root before touching Pilot.
- **Transcript exists, checkpoint absent/stale:** inspect transcript version, terminal boundary, hook hint, partial tail, settings grace, input warnings, and durable ACK failures. Do not advance the offset by hand.
- **Checkpoint advanced, no normalized Droid entries:** confirm output is enabled and search the service log by input ID/session ID. Do not treat JSONL output configuration as OTLP delivery proof.
- **Entries exist, queue pending:** the source is locally safe but remote delivery has not completed. Classify network/429/5xx as retryable; authentication pause and dead-letter as operator action.
- **Queue empty, cloud session missing:** verify endpoint/workspace, exact event timestamp rather than wall-clock now, session ID, remote view filters, and exporter success logs. Do not assume the wrong workspace is a parser failure.
- **Correct structure/model but Tokens=0 or TTFT missing:** exact Droid log observations may be absent. For multiple LLM calls, session/settings aggregate must not be invented as per-call usage. Namespaced aggregate diagnostics may exist while standard `gen_ai.usage.*` remains absent. TTFT stays absent without timing evidence.
- **Wrong model/provider:** transcript metadata outranks Droid native OTLP model fields. Provider normalization should preserve raw evidence only in safe diagnostic attributes.
- **Duplicate session:** first look for two Pilot processes, foreground `dist/index.js`, live plus replay overlap, or a crash between remote acceptance and local deletion. AgentLoop has not proved span-ID deduplication.

Old unsupported transcripts can emit repeated version warnings on every scan. Correlate warnings with the exact new transcript path/session ID and schema version before declaring the current session unsupported.

Historical Droid inspection is dry-run only:

```bash
loongsuite-pilot droid replay --session-id "$SESSION_ID" --dry-run --json
```

Project only summary counters from that output. Do not dump internal plan entries because they can contain content, and never bypass the `--execute` guard.

## Native Droid OTLP boundary

Droid native OTLP is not the AgentLoop session source. It can produce disconnected root spans, incorrect model attribution, and insufficient `gen_ai.*` hierarchy/usage. Keep it content-free and route it only to a separate diagnostic collector if enabled.

## Security

- Do not open raw failed spans or transcript content in shared output.
- Report permissions, counts, hashes, and selected safe fields.
- Keep message capture under Pilot masking; Droid content uses the full mask plan even when general masking is relaxed.
- Treat legacy `logs/otlp-failed` as sensitive, lossy, append-only evidence. Inventory it explicitly; never auto-migrate or auto-replay it.
