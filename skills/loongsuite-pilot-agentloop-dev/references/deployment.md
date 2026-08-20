# Build and versioned deployment

Use this reference only when the task includes build, package, install, upgrade, readiness, or rollback.

## Preflight

Resolve these values without exposing config contents:

```bash
REPO="${LOONGSUITE_PILOT_REPO:-/Users/jaymie/github/loongsuite-pilot}"
cd "$REPO"
git status --short --branch
git log -1 --oneline --decorate
node -v
npm -v
loongsuite-pilot status
```

Confirm:

- The intended commit is present and unrelated work is not included.
- Node satisfies the repository requirement.
- `~/.loongsuite-pilot/config.json` is `0600`; data, state, and spool directories are `0700`.
- Durable queue has no dead-letter item before cutover.
- A known rollback version exists.
- Free disk can hold the package, another version, the spool cap, and existing legacy failed files.

Do not print `config.json` to prove it exists.

## Quality gates

Choose tests proportional to the change, but do not skip the cross-layer tests when changing checkpoint, flusher, installer, or Droid semantics:

```bash
(
  PILOT_INSTALL_SCRATCH="$(mktemp -d)"
  trap 'rm -rf "$PILOT_INSTALL_SCRATCH"' EXIT
  LOONGSUITE_PILOT_DATA_DIR="$PILOT_INSTALL_SCRATCH" npm ci
)
npm run typecheck
npm test
bash -n scripts/loongsuite-pilot.sh deploy/installer-opensource.sh
git diff --check
```

`npm install` and `npm ci` run this repository's `postinstall`, which copies hooks and skills. Always redirect `LOONGSUITE_PILOT_DATA_DIR` to an isolated temporary directory during dependency setup so a developer checkout cannot overwrite live integrations. Remove that specific scratch directory after inspection.

For a commit or staged patch, run the repository's secret scan when available. Synthetic credentials in tests should be constructed so the scanner does not need a broad allowlist.

Build only from a clean, committed HEAD. Packaging writes `VERSION` from Git HEAD but does not reject a dirty tree, and the installer compares `version + commit`; a dirty package can therefore be mislabeled or treated as already installed. Never commit the generated macOS status-bar Mach-O merely because a build rewrote it. Review `git status` after build and exclude that generated artifact.

## Package

The supported local package path is:

```bash
cd "$REPO"
bash deploy/package-opensource.sh -o /tmp/loongsuite-pilot-local.tar.gz
```

The package must contain `VERSION`, `dist/`, `assets/`, `agents.d/`, `scripts/`, `package.json`, and the lockfile. Runtime dependencies are managed by the installer rather than embedded in this archive. Inspect `VERSION` and archive contents before installing. The `version + git_commit` pair must distinguish the candidate from every installed version; do not overwrite an existing version directory.

## Standard local upgrade

Use the installer rather than copying files into the data directory:

```bash
bash deploy/installer-opensource.sh upgrade \
  --package-url "file:///tmp/loongsuite-pilot-local.tar.gz"
```

The installer preserves configuration and uses version pointers. Its readiness result must be based on all of the following, not only process existence:

- `logs/runtime.json.status == "active"`
- runtime PID equals `loongsuite-pilot.pid`
- that PID is alive
- `runtime.json.updatedAt` is fresh and newer than cutover
- `loongsuite-pilot status` reports the intended commit/version

Cold startup can take several minutes because agent discovery starts inputs sequentially and initial transcript scans are awaited. Use the repository's bounded readiness polling; a two-second PID check is not sufficient.

### Fixed rollback target caveat

Stock `upgrade` makes the old current version the new `previous` and may garbage-collect versions outside `current + previous`. If the user requires `previous` to remain a fixed original release while retaining an intermediate canary, do not use stock upgrade unchanged. Stop and propose a reviewed manual versioned cutover or installer enhancement. Snapshot pointers and integration files before stop; snapshot mutable checkpoint/spool state only after the service has stopped. Never restore old checkpoint or spool data blindly during rollback.

## Readiness and canary acceptance

After runtime readiness:

1. Confirm the intended input is registered and started in the service log.
2. Run one bounded Droid canary with no workspace writes.
3. Capture its exact session ID.
4. Verify local checkpoint, normalized entries, durable queue, then AgentLoop in that order.
5. Require zero dead-letter items. A temporary pending item proves only local durable acceptance; final remote acceptance requires it to drain.

Do not use an old session to prove a new build.

Keep auto-update disabled or pinned for a local canary so an updater cannot replace it before acceptance finishes.

## Rollback

Use the installed CLI:

```bash
loongsuite-pilot rollback
loongsuite-pilot status
```

Apply the same readiness gate to the rollback target. A rollback that only changes `current` but never reaches an active fresh runtime is not successful. Preserve new spool/checkpoint data unless a separate recovery analysis proves it is unsafe.

`failed replay --execute` is also a mutating remote-delivery operation and requires explicit user authorization. It is distinct from the disabled Droid historical replay.
