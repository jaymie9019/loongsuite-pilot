import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';

const runtimeScript = resolve('scripts', 'loongsuite-pilot.sh');
const sandboxes = [];

function writeExecutable(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function createRollbackInstall({ previousHasCollector = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'pilot-rollback-'));
  sandboxes.push(home);

  const pilotDir = path.join(home, '.loongsuite-pilot');
  const versionsDir = path.join(pilotDir, 'versions');
  const currentDir = path.join(versionsDir, 'current-build');
  const previousDir = path.join(versionsDir, 'previous-build');
  const bootstrapDir = path.join(pilotDir, 'bin');
  const commandPath = path.join(home, '.local', 'bin', 'loongsuite-pilot');
  const fakeBin = path.join(home, 'fake-bin');

  mkdirSync(path.join(currentDir, 'scripts'), { recursive: true });
  mkdirSync(path.join(previousDir, 'scripts'), { recursive: true });
  mkdirSync(bootstrapDir, { recursive: true });
  mkdirSync(path.dirname(commandPath), { recursive: true });

  writeFileSync(path.join(pilotDir, 'current'), 'current-build\n');
  writeFileSync(path.join(pilotDir, 'previous'), 'previous-build\n');
  writeFileSync(path.join(currentDir, 'scripts', 'collector-daemon.js'), 'current collector\n');
  writeFileSync(path.join(currentDir, 'scripts', 'loongsuite-pilot.sh'), 'current command\n');
  if (previousHasCollector) {
    writeFileSync(path.join(previousDir, 'scripts', 'collector-daemon.js'), 'previous collector\n');
  }
  writeFileSync(path.join(previousDir, 'scripts', 'loongsuite-pilot.sh'), 'previous command\n');

  writeFileSync(path.join(bootstrapDir, 'collector-daemon.js'), 'current collector\n');
  writeFileSync(path.join(bootstrapDir, 'updater-daemon.js'), 'stale updater\n');
  writeFileSync(commandPath, 'current command\n');

  writeExecutable(path.join(fakeBin, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'pkill'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(
    path.join(fakeBin, 'uname'),
    '#!/usr/bin/env bash\n[ "${1:-}" = "-m" ] && echo arm64 || echo Darwin\n',
  );

  return {
    home,
    pilotDir,
    bootstrapDir,
    commandPath,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      SHELL: '/bin/zsh',
    },
  };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loongsuite-pilot rollback', () => {
  it('rolls back to an opensource package that has no updater daemon', () => {
    const install = createRollbackInstall();

    const result = spawnSync('bash', [runtimeScript, 'rollback'], {
      encoding: 'utf8',
      env: install.env,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(path.join(install.pilotDir, 'current'), 'utf8')).toBe('previous-build\n');
    expect(readFileSync(path.join(install.pilotDir, 'previous'), 'utf8')).toBe('current-build\n');
    expect(readFileSync(path.join(install.bootstrapDir, 'collector-daemon.js'), 'utf8'))
      .toBe('previous collector\n');
    expect(existsSync(path.join(install.bootstrapDir, 'updater-daemon.js'))).toBe(false);
    expect(readFileSync(install.commandPath, 'utf8')).toBe('previous command\n');
    expect(result.stdout).toContain('Rolled back to version: previous-build');
  });

  it('refuses a rollback target that has no collector daemon', () => {
    const install = createRollbackInstall({ previousHasCollector: false });

    const result = spawnSync('bash', [runtimeScript, 'rollback'], {
      encoding: 'utf8',
      env: install.env,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Failed to sync scripts for rollback target: previous-build');
    expect(readFileSync(path.join(install.pilotDir, 'current'), 'utf8')).toBe('current-build\n');
    expect(readFileSync(path.join(install.pilotDir, 'previous'), 'utf8')).toBe('previous-build\n');
    expect(readFileSync(path.join(install.bootstrapDir, 'collector-daemon.js'), 'utf8'))
      .toBe('current collector\n');
    expect(readFileSync(install.commandPath, 'utf8')).toBe('current command\n');
  });
});
