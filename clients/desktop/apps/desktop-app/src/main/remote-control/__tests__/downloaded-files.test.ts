import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { markAsDownloaded, quarantineValue } from '../client/downloaded-files';

const onMac = hostPlatformOperatingSystem() === 'darwin' ? it : it.skip;

describe('markAsDownloaded', () => {
  it('writes the quarantine value browsers write', () => {
    expect(quarantineValue(Date.UTC(2026, 9, 15) + 999, 'Canopy')).toBe(
      `0081;${(Date.UTC(2026, 9, 15) / 1000).toString(16)};Canopy;`,
    );
  });

  onMac('quarantines the file on macOS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'downloaded-files-'));
    try {
      const path = join(dir, 'report.pdf');
      writeFileSync(path, 'pdf');
      await markAsDownloaded(path, {
        agentName: 'Canopy',
        os: 'darwin',
        nowMs: 0,
      });
      expect(
        execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path])
          .toString()
          .trim(),
      ).toBe('0081;0;Canopy;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves files alone where the system has no download mark', async () => {
    await expect(
      markAsDownloaded(join(tmpdir(), 'missing-file'), {
        agentName: 'Canopy',
        os: 'linux',
      }),
    ).resolves.toBeUndefined();
  });

  onMac('fails when the file cannot be marked', async () => {
    await expect(
      markAsDownloaded(join(tmpdir(), 'missing-file'), {
        agentName: 'Canopy',
        os: 'darwin',
      }),
    ).rejects.toThrow();
  });
});
