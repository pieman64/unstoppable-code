import { spawnSync } from 'node:child_process';
import fileSystem, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleKind, transpileModule } from 'typescript';

const mockGetProfile = jest.fn(() => '/private/example-profile');
jest.mock('electron', () => ({
  app: { getPath: mockGetProfile },
}));

describe('installed instance lifecycle receipts', () => {
  const originalE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Reflect.set(globalThis, '__CANOPY_E2E__', false);
  });

  afterEach(() => {
    if (typeof originalE2e === 'boolean')
      Reflect.set(globalThis, '__CANOPY_E2E__', originalE2e);
    else Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    jest.restoreAllMocks();
  });

  it('correlates real process and window delivery without disclosing the profile', async () => {
    const { recordDesktopInstanceEvent } =
      await import('../lifecycle/desktop-instance-diagnostics');
    const write = jest.spyOn(fileSystem, 'writeSync').mockReturnValue(1);
    recordDesktopInstanceEvent({ event: 'owner-acquired' });
    recordDesktopInstanceEvent({
      event: 'link-delivered',
      destination: 'settings',
      windowId: 3,
    });
    expect(write).toHaveBeenCalledTimes(2);
    const line = write.mock.calls[1]?.[1];
    expect(typeof line).toBe('string');
    if (typeof line !== 'string') throw new Error('Missing lifecycle receipt');
    expect(line).not.toContain('/private/example-profile');
    const receipt: unknown = JSON.parse(
      line.slice('[desktop-instance] '.length),
    );
    expect(receipt).toMatchObject({
      schema: 1,
      event: 'link-delivered',
      destination: 'settings',
      windowId: 3,
      pid: process.pid,
      brand: 'canopy',
    });
    expect(receipt).toHaveProperty('at', expect.any(Number));
    expect(receipt).toHaveProperty(
      'profileHash',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it('emits no production qualification receipts from the lock-bypassing E2E build', async () => {
    Reflect.set(globalThis, '__CANOPY_E2E__', true);
    const { recordDesktopInstanceEvent } =
      await import('../lifecycle/desktop-instance-diagnostics');
    const write = jest.spyOn(fileSystem, 'writeSync').mockReturnValue(1);
    recordDesktopInstanceEvent({ event: 'owner-acquired' });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the process alive after a real closed stdout write failure', () => {
    const source = readFileSync(
      join(__dirname, '../lifecycle/desktop-instance-diagnostics.ts'),
      'utf8',
    );
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS },
    });
    const script = `
      const diagnosticExports = {};
      global.__CANOPY_E2E__ = false;
      new Function('require', 'exports', ${JSON.stringify(outputText)})(
        (id) => id === 'electron'
          ? { app: { getPath: () => '/synthetic-profile' } }
          : id === '@canopy/brand/current'
            ? { BRAND: { internalName: 'canopy' } }
            : require(id),
        diagnosticExports,
      );
      // Initialize the real stream, then close its OS descriptor. An async
      // stream write emits an unhandled error after the helper returns.
      const stdout = process.stdout;
      require('node:fs').closeSync(stdout.fd);
      diagnosticExports.recordDesktopInstanceEvent({ event: 'contender-rejected' });
      setImmediate(() => process.exit(0));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
