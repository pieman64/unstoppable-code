import type * as childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsUpdateVerifier } from '../updater/windows-update';

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({ ...process.env }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

const windowsTest = process.platform === 'win32' ? it : it.skip;

windowsTest(
  'a real timeout kills the PowerShell reader and its descendant before releasing the installer',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-4188-reader-'));
    const file = join(directory, 'temp-installer.exe');
    const pidFile = join(directory, 'reader.pid');
    await writeFile(file, 'controlled unsigned fixture');
    const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const descendantScript = [
      `$reader = [IO.File]::Open(${literal(file)}, 'Open', 'Read', 'Read')`,
      `[IO.File]::WriteAllText(${literal(pidFile)}, [string]$PID)`,
      'try { Start-Sleep -Seconds 30 } finally { $reader.Dispose() }',
    ].join('; ');
    const descendantCommand = Buffer.from(descendantScript, 'utf16le').toString(
      'base64',
    );
    const parentScript = [
      `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${descendantCommand}'`,
      'Start-Sleep -Seconds 30',
    ].join('; ');
    const actual =
      jest.requireActual<typeof childProcess>('node:child_process');
    const original = actual.execFile;
    const started: childProcess.ChildProcess[] = [];
    const spy = jest.spyOn(actual, 'execFile');
    // Replace only the signature command with a deterministic reader. Preserve
    // the production launch options, deadline and actual taskkill /T cleanup.
    spy.mockImplementation(((executable, args, options, callback) => {
      if (executable !== 'powershell.exe')
        return original(executable, args, options, callback);
      const child = original(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(parentScript, 'utf16le').toString('base64'),
        ],
        options,
        callback,
      );
      started.push(child);
      return child;
    }) as typeof childProcess.execFile);
    try {
      await expect(
        createWindowsUpdateVerifier({ timeoutMs: 5_000 })(['unused'], file),
      ).rejects.toMatchObject({ code: 'ERR_UPDATER_SIGNATURE_TIMEOUT' });
      expect(started).toHaveLength(2);
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      for (const child of started) {
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      }
      // On Windows this fails if either reader survived with its read handle.
      await rm(file);
    } finally {
      spy.mockRestore();
      for (const child of started) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) =>
            original(
              'taskkill',
              ['/PID', String(child.pid), '/T', '/F'],
              { windowsHide: true },
              () => resolve(),
            ),
          );
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

windowsTest(
  'verifies an actual Windows executable with Authenticode',
  async () => {
    const file = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const result = await createWindowsUpdateVerifier({ timeoutMs: 60_000 })(
      ['Microsoft Windows', 'Microsoft Corporation'],
      file,
    );
    expect(result).toBeNull();
  },
  150_000,
);
