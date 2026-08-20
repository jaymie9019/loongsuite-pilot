import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = path.resolve('scripts/loongsuite-pilot.sh');

describe('loongsuite-pilot info', () => {
  it('prints useful config while redacting credentials and headers', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pilot-info-'));
    const versionName = '1.3.0_test';
    const versionDir = path.join(dataDir, 'versions', versionName);
    const licenseKey = ['DO_NOT_PRINT_', 'LICENSE'].join('');
    await mkdir(versionDir, { recursive: true });
    await writeFile(path.join(dataDir, 'current'), `${versionName}\n`, { mode: 0o600 });
    await writeFile(
      path.join(versionDir, 'VERSION'),
      'version=1.3.0\ngit_commit=test\n',
      { mode: 0o600 },
    );
    await writeFile(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        userId: 'visible-user',
        cms: { workspace: 'visible-workspace', licenseKey },
        sls: { apiKey: 'DO_NOT_PRINT_API_KEY' },
        http: { headers: { Authorization: 'DO_NOT_PRINT_HEADER' } },
        agents: { droid: { enabled: true, captureMessageContent: true } },
      }),
      { mode: 0o600 },
    );
    await chmod(dataDir, 0o700);

    const output = execFileSync('bash', [cli, 'info'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        LOONGSUITE_PILOT_CACHE_DIR: dataDir,
      },
    });

    expect(output).toContain('visible-user');
    expect(output).toContain('visible-workspace');
    expect(output).toContain('captureMessageContent');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(licenseKey);
    expect(output).not.toContain('DO_NOT_PRINT_API_KEY');
    expect(output).not.toContain('DO_NOT_PRINT_HEADER');
  });
});
