#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PILOT_REPO="${LOONGSUITE_PILOT_REPO:-$DEFAULT_REPO}"
PILOT_DATA_DIR="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"

section() {
  printf '\n== %s ==\n' "$1"
}

mode_of() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    printf 'missing'
  elif stat -f '%Lp' "$target" >/dev/null 2>&1; then
    stat -f '%Lp' "$target"
  else
    stat -c '%a' "$target"
  fi
}

if [[ ! -d "$PILOT_REPO/.git" || ! -f "$PILOT_REPO/package.json" ]]; then
  printf 'ERROR: not a LoongSuite Pilot checkout: %s\n' "$PILOT_REPO" >&2
  exit 1
fi

section "source"
printf 'repo=%s\n' "$PILOT_REPO"
printf 'branch=%s\n' "$(git -C "$PILOT_REPO" branch --show-current 2>/dev/null || printf unknown)"
printf 'commit=%s\n' "$(git -C "$PILOT_REPO" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
printf 'dirty_paths=%s\n' "$(git -C "$PILOT_REPO" status --porcelain=v1 | wc -l | tr -d ' ')"
printf 'package_version=%s\n' "$(node -p "require('$PILOT_REPO/package.json').version" 2>/dev/null || printf unknown)"
printf 'node=%s\n' "$(node -v 2>/dev/null || printf missing)"

section "installed runtime"
PILOT_BIN="$(command -v loongsuite-pilot 2>/dev/null || true)"
if [[ -z "$PILOT_BIN" && -x "$HOME/.local/bin/loongsuite-pilot" ]]; then
  PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"
fi
if [[ -n "$PILOT_BIN" ]]; then
  printf 'binary=%s\n' "$PILOT_BIN"
  "$PILOT_BIN" status 2>&1 || true
else
  printf 'binary=missing\n'
fi
for pointer in current previous; do
  if [[ -f "$PILOT_DATA_DIR/$pointer" ]]; then
    printf '%s=%s\n' "$pointer" "$(tr -d '\r\n' < "$PILOT_DATA_DIR/$pointer")"
  else
    printf '%s=missing\n' "$pointer"
  fi
done

section "permissions"
printf 'data_dir_mode=%s\n' "$(mode_of "$PILOT_DATA_DIR")"
printf 'config_mode=%s\n' "$(mode_of "$PILOT_DATA_DIR/config.json")"
printf 'state_dir_mode=%s\n' "$(mode_of "$PILOT_DATA_DIR/state")"
printf 'spool_dir_mode=%s\n' "$(mode_of "$PILOT_DATA_DIR/spool")"

section "runtime heartbeat"
node - "$PILOT_DATA_DIR/logs/runtime.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
try {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify({
    status: value.status ?? null,
    pid: value.pid ?? null,
    updatedAt: value.updatedAt ?? null,
  }));
} catch (error) {
  console.log(JSON.stringify({ status: 'unavailable', reason: error.code ?? error.name }));
}
NODE

section "Droid source and checkpoint"
printf 'droid=%s\n' "$(droid --version 2>/dev/null || printf missing)"
if [[ -d "$HOME/.factory/sessions" ]]; then
  printf 'factory_transcripts=%s\n' "$(find "$HOME/.factory/sessions" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
else
  printf 'factory_transcripts=missing\n'
fi
node - "$PILOT_DATA_DIR/logs/input-state.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
try {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const extra = state['droid-transcript']?.extra ?? {};
  const pending = Object.values(extra.droidTranscriptFiles ?? {})
    .filter(value => value && typeof value === 'object' && value.pendingBoundarySignature).length;
  console.log(JSON.stringify({
    initialized: extra.droidInitialized === true,
    trackedTranscripts: Object.keys(extra.droidTranscriptBytes ?? {}).length,
    usageBaselines: Object.keys(extra.droidSessionUsage ?? {}).length,
    pendingBoundaries: pending,
  }));
} catch (error) {
  console.log(JSON.stringify({ initialized: false, reason: error.code ?? error.name }));
}
NODE

section "durable OTLP inventory"
if [[ -n "$PILOT_BIN" ]]; then
  if ! LOG_LEVEL=silent "$PILOT_BIN" failed replay --dry-run --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(text);
      const durable = value.durableBefore ?? {};
      console.log(JSON.stringify({
        mode: value.mode ?? null,
        totalBytes: durable.totalBytes ?? 0,
        routes: (durable.routes ?? []).map(route => ({
          pendingItems: route.pendingItems ?? 0,
          deadLetterItems: route.deadLetterItems ?? 0,
          bytes: route.bytes ?? 0,
          pausedHttpStatus: route.pausedHttpStatus ?? null,
        })),
        legacy: {
          files: value.legacyOtlpFailed?.files ?? 0,
          bytes: value.legacyOtlpFailed?.bytes ?? 0,
          migrationSupported: value.legacyOtlpFailed?.migrationSupported ?? false,
        },
        semantics: value.semantics ?? null,
      }));
    });
  '; then
    printf 'unavailable\n'
  fi
else
  printf 'unavailable\n'
fi

section "legacy failed evidence"
LEGACY_DIR="$PILOT_DATA_DIR/logs/otlp-failed"
if [[ -d "$LEGACY_DIR" ]]; then
  printf 'files=%s\n' "$(find "$LEGACY_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf 'kilobytes=%s\n' "$(du -sk "$LEGACY_DIR" 2>/dev/null | awk '{print $1}')"
else
  printf 'files=0\nkilobytes=0\n'
fi
