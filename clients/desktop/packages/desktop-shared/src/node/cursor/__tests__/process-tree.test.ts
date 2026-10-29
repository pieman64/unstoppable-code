import { killProcessGroupByPid } from '@canopy/desktop-shared/node/lib/process-kill';
import { terminateProcessTree } from '../process-tree';

jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killProcessGroupByPid: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  jest.mocked(killProcessGroupByPid).mockClear();
});

describe('Cursor process tree termination', () => {
  it('delegates to the shared helper that owns the platform split', () => {
    // The helper signals the POSIX group, falls back to taskkill /T on
    // Windows, hides its console window, and retries a direct kill. Cursor
    // must not reimplement any of that.
    terminateProcessTree(4321, 'SIGTERM');
    expect(killProcessGroupByPid).toHaveBeenCalledWith(4321, 'SIGTERM');
    terminateProcessTree(4321, 'SIGKILL');
    expect(killProcessGroupByPid).toHaveBeenLastCalledWith(4321, 'SIGKILL');
  });

  it('does nothing without a live pid', () => {
    // A missing, zero, or negative pid would signal the caller's own group.
    terminateProcessTree(undefined, 'SIGTERM');
    terminateProcessTree(0, 'SIGTERM');
    terminateProcessTree(-1, 'SIGKILL');
    expect(killProcessGroupByPid).not.toHaveBeenCalled();
  });

  it('never rejects when the helper fails, because teardown is synchronous', async () => {
    jest
      .mocked(killProcessGroupByPid)
      .mockRejectedValueOnce(new Error('taskkill unavailable'));
    expect(() => terminateProcessTree(4321, 'SIGKILL')).not.toThrow();
    await Promise.resolve();
  });
});

describe('Windows tree reclamation', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  });

  it('forces the tree kill on Windows so children are not orphaned', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    // A graceful taskkill cannot close a windowless console process, so the
    // shared helper would fall back to terminating the parent alone.
    terminateProcessTree(4321, 'SIGTERM');
    expect(killProcessGroupByPid).toHaveBeenCalledWith(4321, 'SIGKILL');
  });

  it('keeps the graceful signal on POSIX, where the group receives it', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    terminateProcessTree(4321, 'SIGTERM');
    expect(killProcessGroupByPid).toHaveBeenCalledWith(4321, 'SIGTERM');
  });
});
