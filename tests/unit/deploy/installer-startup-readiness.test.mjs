import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';

const installer = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const START = '# >>> startup-readiness >>>';
const END = '# <<< startup-readiness <<<';

function extractReadinessBlock() {
  const start = installer.indexOf(START);
  const end = installer.indexOf(END, start);
  if (start < 0 || end <= start) throw new Error('startup-readiness block not found');
  return installer.slice(start, end + END.length);
}

function runReadiness({ runtime, pid = process.pid, timeoutSeconds = '0' }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pilot-readiness-'));
  const logs = path.join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(root, 'loongsuite-pilot.pid'), `${pid}\n`);
  writeFileSync(path.join(logs, 'runtime.json'), `${JSON.stringify(runtime)}\n`);
  writeFileSync(path.join(root, 'readiness.sh'), extractReadinessBlock());

  try {
    return spawnSync('bash', ['-c', `
set -uo pipefail
source "$1/readiness.sh"
DATA_DIR="$1"
NODE_BIN="$2"
if wait_for_startup_readiness; then
  echo READY
  exit 0
fi
echo NOT_READY
exit 42
`, 'readiness-test', root, process.execPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LOONGSUITE_PILOT_STARTUP_READY_TIMEOUT_SECONDS: timeoutSeconds,
        LOONGSUITE_PILOT_STARTUP_READY_POLL_SECONDS: '0',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('installer startup readiness', () => {
  it('accepts a live PID only when runtime status and updatedAt are ready', () => {
    const result = runReadiness({
      runtime: {
        packageVersion: '1.3.0',
        pid: process.pid,
        status: 'active',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('READY');
  });

  it('rejects an old updatedAt even when a separate heartbeatAt is fresh', () => {
    const result = runReadiness({
      runtime: {
        packageVersion: '1.3.0',
        pid: process.pid,
        status: 'active',
        updatedAt: '2000-01-01T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    });

    expect(result.status, result.stderr).toBe(42);
    expect(result.stdout).toContain('NOT_READY');
  });

  it('rejects a fresh active runtime whose PID differs from the pidfile', () => {
    const result = runReadiness({
      runtime: {
        packageVersion: '1.3.0',
        pid: process.pid + 1,
        status: 'active',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(result.status, result.stderr).toBe(42);
    expect(result.stdout).toContain('NOT_READY');
  });

  it('rejects a fresh runtime until its status is active', () => {
    const result = runReadiness({
      runtime: {
        packageVersion: '1.3.0',
        pid: process.pid,
        status: 'starting',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(result.status, result.stderr).toBe(42);
    expect(result.stdout).toContain('NOT_READY');
  });

  it('uses a 600 second production timeout with test-overridable polling', () => {
    const readiness = extractReadinessBlock();

    expect(readiness).toContain('LOONGSUITE_PILOT_STARTUP_READY_TIMEOUT_SECONDS:-600');
    expect(readiness).toContain('LOONGSUITE_PILOT_STARTUP_READY_POLL_SECONDS:-2');
    expect(readiness).toContain('Date.parse(runtime.updatedAt)');
    expect(readiness).not.toContain('runtime.heartbeatAt');
  });

  it('makes upgrade success depend on runtime readiness instead of a process-only status check', () => {
    const start = installer.indexOf('cmd_upgrade() {');
    const end = installer.indexOf('# GC: remove old version directories', start);
    const upgrade = installer.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(upgrade).toContain('if wait_for_startup_readiness; then');
    expect(upgrade).not.toContain('sleep 2');
    expect(upgrade).not.toContain('loongsuite-pilot status');
  });

  it('lets first install finish with a warning when readiness times out', () => {
    const start = installer.indexOf('cmd_install() {');
    const end = installer.indexOf('# CMD: upgrade', start);
    const install = installer.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(install).toContain('if wait_for_startup_readiness; then');
    expect(install).toContain('Service did not become ready before the startup timeout');
    expect(install).not.toContain('loongsuite-pilot rollback');
    expect(install).not.toContain('loongsuite-pilot status');
  });
});
