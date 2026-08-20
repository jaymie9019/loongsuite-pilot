---
name: loongsuite-pilot-agentloop-dev
description: Build, package, deploy, roll back, extend, and diagnose a modified LoongSuite Pilot fork with AgentLoop, especially Factory Droid transcript ingestion and durable OTLP delivery. Use for source changes, local canaries, malformed AgentLoop sessions, or queue/checkpoint failures; use loongsuite-pilot-ops for ordinary end-user installation.
---

# LoongSuite Pilot × AgentLoop Development

Use this Skill for the developer workflow around a modified Pilot source tree. Keep ordinary product installation and SLS configuration in `loongsuite-pilot-ops`.

## Establish the two states first

Treat the source checkout and installed runtime as independent:

- Discover the checkout from the current workspace or `LOONGSUITE_PILOT_REPO`; on this machine the usual fork is `/Users/jaymie/github/loongsuite-pilot`.
- Resolve the live runtime with `loongsuite-pilot status`, `~/.loongsuite-pilot/current`, the version directory, PID, and `logs/runtime.json`.
- Never claim a source commit is running merely because it was built or committed.

Run `scripts/preflight.sh` for a content-free snapshot before deployment or diagnosis. It reports versions, permissions, Droid checkpoint summary, and queue inventory without printing config values or transcript content.

## Route the request

- For build, package, canary upgrade, readiness, or rollback, read [references/deployment.md](references/deployment.md).
- For a missing or malformed AgentLoop session, read [references/diagnostics.md](references/diagnostics.md).
- Before changing Droid ingestion, OTLP conversion, durability, replay, or adding a new feature, read [references/extensions.md](references/extensions.md).

Read only the references needed for the current request.

## Non-negotiable boundaries

1. Diagnosis is read-only unless the user separately authorizes build, deploy, restart, config mutation, rollback, or replay.
2. Do not run `node dist/index.js` beside the launchd service against the same data directory; two collectors can duplicate telemetry.
3. Do not overwrite `~/.loongsuite-pilot/current`, an installed bundle, checkpoint, spool, Factory settings, or hooks by hand for a normal deployment. Build a package and install a distinct version.
4. Preserve user changes and all runtime evidence. Never delete or auto-replay legacy `logs/otlp-failed`, durable spool data, transcripts, or checkpoint state.
5. Prove four layers separately: source event, Pilot checkpoint/output, durable export state, and exact AgentLoop session visibility. One layer does not prove the next.
6. Never print or copy `licenseKey`, Authorization headers, access keys, prompts, tool arguments/results, owner/email, or raw failed spans. Report only paths, modes, counts, IDs supplied by the user, and sanitized metadata.
7. AgentLoop has not demonstrated idempotent deduplication for identical span IDs. `droid replay --execute` is intentionally unavailable until live/replay share a crash-safe emission receipt or outbox. Do not bypass this guard.

## Completion evidence

For a code change, report the commit/worktree actually tested and the relevant tests. For a deployment, report source commit, installed version, readiness evidence, rollback target, and queue health. For a session diagnosis, state which of the four layers passed or failed and what evidence proves it.
