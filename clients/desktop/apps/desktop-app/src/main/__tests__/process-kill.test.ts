jest.mock('node:child_process', () => {
  const actual: Record<string, unknown> =
    jest.requireActual('node:child_process');
  return {
    ...actual,
    execFile: jest.fn(),
    spawn: jest.fn(),
    spawnSync: jest.fn(),
  };
});

import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  killChildProcessGroup as killSharedChildProcessGroup,
  killProcessGroupByPid,
} from '@canopy/desktop-shared/node/lib/process-kill';
import { drainOwnedProcess, killChildProcessGroup } from '../lib/process-kill';

const mockedSpawn = jest.mocked(spawn);
const mockedSpawnSync = jest.mocked(spawnSync);
const mockedExecFile = jest.mocked(execFile);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  jest.clearAllMocks();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
});

describe.each([
  ['desktop', killChildProcessGroup],
  ['shared', killSharedChildProcessGroup],
])('%s killChildProcessGroup on Windows', (_host, killGroup) => {
  function startTaskkill(): EventEmitter {
    const taskkill = new EventEmitter();
    mockedSpawn.mockReturnValue(taskkill as unknown as ChildProcess);
    return taskkill;
  }

  beforeEach(() => setPlatform('win32'));

  it('returns before taskkill finishes instead of blocking the main thread', () => {
    const taskkill = startTaskkill();
    const kill = jest.fn();
    const child = { pid: 123, kill } as unknown as ChildProcess;

    killGroup(child, 'SIGKILL');

    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '123', '/t', '/f'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    taskkill.emit('exit', 0, null);
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill once when taskkill fails', () => {
    const taskkill = startTaskkill();
    const kill = jest.fn();
    const child = { pid: 123, kill } as unknown as ChildProcess;

    killGroup(child, 'SIGTERM');
    expect(kill).not.toHaveBeenCalled();
    taskkill.emit('error', new Error('spawn taskkill ENOENT'));
    taskkill.emit('exit', 1, null);

    expect(mockedSpawn.mock.calls[0]?.[1]).toEqual(['/pid', '123', '/t']);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not throw when taskkill and the fallback child.kill both fail', () => {
    const taskkill = startTaskkill();
    const kill = jest.fn(() => {
      throw new Error('ESRCH');
    });
    const child = { pid: 123, kill } as unknown as ChildProcess;

    killGroup(child, 'SIGTERM');

    expect(() => taskkill.emit('exit', 1, null)).not.toThrow();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('killProcessGroupByPid', () => {
  it('bounds Windows taskkill and falls back when the operation times out', async () => {
    setPlatform('win32');
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const operation = killProcessGroupByPid(789, 'SIGKILL', {
        timeoutMs: 5_000,
      });
      const callback = mockedExecFile.mock.calls[0]?.[3];
      if (typeof callback !== 'function')
        throw new Error('Expected taskkill callback.');
      callback(
        Object.assign(new Error('taskkill timed out'), { killed: true }),
        '',
        '',
      );
      await operation;
      expect(mockedExecFile).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '789', '/t', '/f'],
        expect.objectContaining({ timeout: 5_000, windowsHide: true }),
        expect.any(Function),
      );
      expect(kill).toHaveBeenCalledWith(789, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('signals the detached process group on Unix', async () => {
    setPlatform('darwin');
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);

    await killProcessGroupByPid(456, 'SIGKILL');

    expect(kill).toHaveBeenCalledWith(-456, 'SIGKILL');
    kill.mockRestore();
  });

  it('terminates the full process tree asynchronously on Windows', async () => {
    setPlatform('win32');

    const termination = killProcessGroupByPid(789, 'SIGKILL');
    const callback = mockedExecFile.mock.calls[0]?.[3];
    if (typeof callback !== 'function') {
      throw new Error('Expected taskkill callback.');
    }
    callback(null, '', '');
    await termination;

    expect(mockedExecFile).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '789', '/t', '/f'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});

describe('drainOwnedProcess', () => {
  it('fails closed before signaling when the tracked owner changed', async () => {
    setPlatform('darwin');
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    try {
      await expect(
        Reflect.apply(drainOwnedProcess, undefined, [
          789,
          (): boolean => false,
        ]),
      ).rejects.toThrow('ownership changed');
      expect(kill).not.toHaveBeenCalledWith(-789, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(789, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('awaits asynchronous Windows tree termination before confirming exit', async () => {
    setPlatform('win32');
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    try {
      let done = false;
      const operation = drainOwnedProcess(789).then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(mockedSpawnSync).not.toHaveBeenCalled();
      const callback = mockedExecFile.mock.calls[0]?.[3];
      if (typeof callback !== 'function')
        throw new Error('Expected taskkill callback.');
      callback(null, '', '');
      await operation;
      expect(mockedExecFile).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '789', '/t', '/f'],
        expect.objectContaining({ timeout: 5_000, windowsHide: true }),
        expect.any(Function),
      );
    } finally {
      kill.mockRestore();
    }
  });

  it('refuses completion when Windows tree termination fails and the owner remains alive', async () => {
    setPlatform('win32');
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const operation = drainOwnedProcess(789);
      const assertion = expect(operation).rejects.toThrow('locked');
      const callback = mockedExecFile.mock.calls[0]?.[3];
      if (typeof callback !== 'function')
        throw new Error('Expected taskkill callback.');
      callback(new Error('locked'), '', '');
      await assertion;
    } finally {
      kill.mockRestore();
    }
  });

  it('does not treat a exited Unix root as proof that its descendants are gone', async () => {
    setPlatform('darwin');
    jest.useFakeTimers();
    const kill = jest
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) => {
        if (pid === 789 && signal === 0)
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
    try {
      const assertion = expect(drainOwnedProcess(789)).rejects.toThrow(
        'did not exit',
      );
      await jest.advanceTimersByTimeAsync(5_100);
      await assertion;
      expect(kill).toHaveBeenCalledWith(-789, 'SIGKILL');
    } finally {
      kill.mockRestore();
      jest.useRealTimers();
    }
  });
});
