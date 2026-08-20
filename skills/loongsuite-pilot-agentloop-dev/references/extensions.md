# Extending the Droid and AgentLoop path

Read this before changing ingestion, semantic mapping, OTLP transport, replay, or adding a related feature.

## Code map

| Concern | Primary files |
|---|---|
| Agent identity/config | `src/types/client-type.ts`, `src/core/config-loader.ts`, `agents.d/droid.json` |
| Registration/lifecycle | `src/core/orchestrator.ts`, `src/core/input-manager.ts`, `src/inputs/base/base-input.ts` |
| Droid parsing | `src/inputs/droid/droid-parser.ts`, `droid-log-reader.ts`, `droid-types.ts` |
| Turn/event building | `src/inputs/droid/droid-event-builder.ts` |
| Discovery/checkpoint/hooks | `src/inputs/droid/droid-input.ts`, `assets/hooks/droid-*`, `src/hooks/hook-manager.ts` |
| OT-AI hierarchy/IDs | `src/flushers/otlp-trace-flusher.ts`, `tool-span-id-reservation.ts` |
| Durable delivery | `src/flushers/durable-otlp-queue.ts`, `multi-flusher.ts` |
| Operator commands | `src/cli/droid-replay.ts`, `src/cli/failed-replay.ts`, `scripts/loongsuite-pilot.*` |

`agents.d/droid.json` deploys integration assets; it does not register the input. New inputs must be explicitly registered by the orchestrator.

Keep the three identities aligned: agent type `droid`, listener ID `droid-transcript`, and the hook-event root under `state/droid/hook-events`. `agents.droid.enabled` gates deployment/input; content policy is keyed by `droid`, not the listener ID.

## Reliability invariants

1. Source offsets and hook deletion occur only after the entry sink accepts the batch and checkpoint state persists.
2. Droid acceptance requires a durable OTLP seam. Missing flusher, capacity, identity, fsync, or queue initialization failures must reject source acceptance.
3. A state-save failure restores in-memory input state and retains the hook hint so the same deterministic IDs can be retried.
4. Watcher wakeups during a running collection cycle schedule one follow-up cycle; timer overlap does not create a permanent busy loop.
5. Queue items are persisted atomically before local ACK and removed only after exporter success. The spool has a hard cap and does not silently delete old data.
6. Do not route durable enqueue failure into the old lossy `otlp-failed` append path.

The expected commit order is:

```text
collect → awaited InputManager sink → content policy + masking
→ every OTLP route local fsync ACK → beforeCheckpoint
→ StateStore.save → afterCheckpoint hook deletion
```

JSONL/SLS auxiliary failure does not veto a Droid checkpoint; failure of any durable OTLP participant does.

## Semantic invariants

- A real visible user prompt starts a turn; `tool_result` alone does not.
- `llm_only`, system/context injections, and owner/email are not uploaded.
- `tool_use_id` joins call/result. Unresolved tools and interrupted turns become cancelled rather than silently complete.
- Child sessions are distinct sessions; parent ID is diagnostic only. Do not double-count inclusive usage.
- IDs derive from session/turn/kind/ordinal-or-tool ID using NUL-separated SHA-256 seeds. Update reservation and final `ReadableSpan` tests together.
- Droid entries bypass upstream trace-ID rewriting so live and reconstruction retain the same IDs.

On first enable, supported existing transcripts are baselined at EOF and are not uploaded. Unknown transcript versions, partial tails, incomplete scans, unstable boundaries, and path escapes must not advance an offset or delete a hook hint. An external Stop hint may close only records at or before its timestamp, never an arbitrary current EOF.

## Usage and compatibility invariants

Trust sources in this order: transcript structure/model/provider, version-gated Droid log observations for per-call usage/timing, then settings aggregates for diagnostics or narrowly proven fallback.

- Supported log schemas are exact allowlisted versions, currently `0.199.0` and `0.200.0`; unknown versions fail closed.
- Ambiguous concurrent log matches are dropped, never guessed.
- Tail reads must resynchronize at a complete semantic call, not only a newline.
- A settings delta can populate standard usage only when provenance proves it belongs to exactly one raw LLM call. Hidden `llm_only` calls count when deciding this.
- Missing timing evidence means no TTFT.
- Keep `agent.droid.usage.completeness` and safe aggregate diagnostics through conversion with an explicit allowlist; do not broadly pass through `agent.droid.*`.

## Privacy invariants

- Hooks write structural metadata only: session ID, transcript path, event, timestamp, and tool ID as needed.
- Do not copy prompt, tool arguments, tool output, credentials, or raw log lines into hook events.
- Force Droid message content through the full mask plan.
- Cap tool argument/result fields while preserving valid JSON.
- Runtime data directories are `0700`; config, state, hook events, spool, and failed-span files are `0600`.
- New content must use canonical fields covered by `src/mask/field-whitelist.ts`; never hide prompt/tool payload in a namespaced diagnostic field that bypasses masking.

## Replay boundary

Dry-run planning is allowed. Execute remains disabled because queue-first/ledger-second can crash after remote success but before the ledger receipt, and the live collector does not share a transactional outbox with replay. Do not add a force flag. A future implementation needs one crash-safe receipt/outbox shared by live and replay.

## Tests to route with the change

- Parser/log schema/tail: `tests/unit/inputs/droid-parser.test.ts`, `droid-log-reader.test.ts`
- Turn/model/tool/usage/IDs: `droid-event-builder.test.ts`
- Baseline, restart, delayed settings, hook cleanup, checkpoint ACK: `droid-input.test.ts`
- Final hierarchy and diagnostic attributes: OTLP flusher conversion/export tests
- Queue fsync/cap/retry/auth/dead-letter/restart: `durable-otlp-queue.test.ts`
- CLI safety and replay guards: `droid-replay.test.ts`, `failed-replay.test.ts`
- Hook coexistence/install/uninstall: Droid hook and installer cleanup tests
- Generic regressions: InputManager, BaseInput, MultiFlusher, existing agent inputs

Use TDD for behavior changes. Verify the final `ReadableSpan` tree, not only intermediate `AgentActivityEntry` objects. Before deployment run typecheck, relevant suites, installer shell syntax, `git diff --check`, and a secret scan.

The tracked golden fixture under `tests/fixtures/droid/golden-v2/` represents 2 LLM calls, 1 TOOL, model `claude-opus-4-7`, provider `aws.bedrock`, input `40601`, output `203`, and total `40804`. Its `droid.log` matches the repository-wide `*.log` ignore, so verify it remains tracked whenever fixtures are copied or regenerated.
