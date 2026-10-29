const chmodMock = jest.fn();
const lstatMock = jest.fn();
const openMock = jest.fn();
const readFileMock = jest.fn();
const realpathMock = jest.fn();
const statMock = jest.fn();
const unlinkMock = jest.fn();
const mkdirMock = jest.fn();
const rmdirMock = jest.fn();
const writeFileMock = jest.fn();

jest.mock('node:fs/promises', () => ({
  chmod: chmodMock,
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readFile: readFileMock,
  realpath: realpathMock,
  rmdir: rmdirMock,
  stat: statMock,
  unlink: unlinkMock,
  writeFile: writeFileMock,
}));
jest.mock('../lib/paths', () => ({
  getDataDir: (): string => '/mock/data',
}));

import { withMarketplaceRefreshLock } from '../plugins/marketplace-refresh-lock';

describe('withMarketplaceRefreshLock', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
    realpathMock.mockImplementation((target: string) =>
      Promise.resolve(target),
    );
    chmodMock.mockResolvedValue(undefined);
    lstatMock.mockImplementation((target: string) => {
      const isFile = target.endsWith('.lock');
      return Promise.resolve({
        isDirectory: () => !isFile,
        isFile: () => isFile,
        isSymbolicLink: () => false,
        mode: isFile ? 0o600 : 0o700,
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      });
    });
  });

  it('recovers a reclaim marker whose owner process exited', async () => {
    const staleOwner = JSON.stringify({
      version: 1,
      pid: 99_999_999,
      nonce: 'stale-owner',
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    let currentReclaimOwner = JSON.stringify({
      version: 1,
      pid: 99_999_998,
      nonce: 'stale-reclaimer',
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    let primaryExists = true;
    let reclaimExists = true;
    let acquiredOwner = '';
    const primaryHandle = {
      writeFile: jest.fn((contents: string) => {
        acquiredOwner = contents;
        return Promise.resolve();
      }),
      close: jest.fn(() => Promise.resolve()),
    };

    openMock.mockImplementation((target: string) => {
      if (target.endsWith('.reclaim')) {
        return reclaimExists
          ? Promise.reject(
              Object.assign(new Error('exists'), { code: 'EEXIST' }),
            )
          : Promise.resolve({ close: jest.fn(() => Promise.resolve()) });
      }
      return primaryExists
        ? Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }))
        : Promise.resolve(primaryHandle);
    });
    mkdirMock.mockImplementation((target: string) => {
      if (!target.endsWith('.reclaim')) return Promise.resolve();
      if (reclaimExists) {
        return Promise.reject(
          Object.assign(new Error('exists'), { code: 'EEXIST' }),
        );
      }
      reclaimExists = true;
      return Promise.resolve();
    });
    readFileMock.mockImplementation((target: string) => {
      if (target.endsWith('.reclaim/owner.json')) {
        return Promise.resolve(currentReclaimOwner);
      }
      return Promise.resolve(primaryExists ? staleOwner : acquiredOwner);
    });
    statMock.mockResolvedValue({ mtimeMs: -60_000 });
    unlinkMock.mockImplementation((target: string) => {
      if (target.endsWith('.lock')) primaryExists = false;
      if (target.endsWith('.reclaim/owner.json')) currentReclaimOwner = '';
      return Promise.resolve();
    });
    rmdirMock.mockImplementation(() => {
      reclaimExists = false;
      return Promise.resolve();
    });
    writeFileMock.mockImplementation((_target: string, contents: string) => {
      currentReclaimOwner = contents;
      return Promise.resolve();
    });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 99_999_999 || pid === 99_999_998) {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }
      return true;
    });

    try {
      await expect(
        withMarketplaceRefreshLock(() => Promise.resolve('done')),
      ).resolves.toBe('done');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not unlink a replacement owner during stale-lock reclamation', async () => {
    const events: string[] = [];
    const staleOwner = {
      version: 1,
      pid: 99_999_999,
      nonce: 'stale-owner',
      createdAt: '2026-08-20T00:00:00.000Z',
    };
    const replacementOwner = {
      version: 1,
      pid: process.pid,
      nonce: 'replacement-owner',
      createdAt: '2026-08-20T00:00:01.000Z',
    };
    let acquiredOwner = '';
    let reclaimOwner = '';
    let primaryReadCount = 0;
    const handle = {
      writeFile: jest.fn((contents: string) => {
        acquiredOwner = contents;
        return Promise.resolve();
      }),
      close: jest.fn(() => Promise.resolve()),
    };
    openMock
      .mockRejectedValueOnce(
        Object.assign(new Error('exists'), { code: 'EEXIST' }),
      )
      .mockResolvedValue(handle);
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockImplementation((_target: string, contents: string) => {
      reclaimOwner = contents;
      return Promise.resolve();
    });
    readFileMock.mockImplementation((target: string) => {
      if (target.endsWith('.reclaim/owner.json')) {
        return Promise.resolve(reclaimOwner);
      }
      primaryReadCount += 1;
      if (primaryReadCount === 1)
        return Promise.resolve(JSON.stringify(staleOwner));
      if (primaryReadCount === 2) {
        return Promise.resolve(JSON.stringify(replacementOwner));
      }
      return Promise.resolve(acquiredOwner);
    });
    rmdirMock.mockResolvedValue(undefined);
    unlinkMock.mockImplementation((target: string) => {
      if (target.endsWith('.lock')) {
        events.push('unlink');
      }
      return Promise.resolve();
    });
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === staleOwner.pid) {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }
      return true;
    });

    try {
      await expect(
        withMarketplaceRefreshLock(() => {
          events.push('operation');
          return Promise.resolve('done');
        }),
      ).resolves.toBe('done');
    } finally {
      killSpy.mockRestore();
    }

    expect(events).toEqual(['operation', 'unlink']);
  });

  it('shares a lock when only one provider state root overlaps', async () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalCodexHome = process.env.CODEX_HOME;
    const openedPaths: string[] = [];
    let owner = '';
    const handle = {
      writeFile: jest.fn((contents: string) => {
        owner = contents;
        return Promise.resolve();
      }),
      close: jest.fn(() => Promise.resolve()),
    };
    openMock.mockImplementation((target: string) => {
      openedPaths.push(target);
      return Promise.resolve(handle);
    });
    readFileMock.mockImplementation(() => Promise.resolve(owner));
    unlinkMock.mockResolvedValue(undefined);

    try {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-a';
      process.env.CODEX_HOME = '/tmp/shared-codex';
      await withMarketplaceRefreshLock(() => Promise.resolve());
      const firstPaths = new Set<string>(openedPaths.splice(0));

      process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-b';
      await withMarketplaceRefreshLock(() => Promise.resolve());
      const secondPaths = new Set<string>(openedPaths);

      expect(
        Array.from(firstPaths).some((lockPath) => secondPaths.has(lockPath)),
      ).toBe(true);
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('stores provider locks beneath the private app data directory', async () => {
    const openedPaths: string[] = [];
    let owner = '';
    const handle = {
      writeFile: jest.fn((contents: string) => {
        owner = contents;
        return Promise.resolve();
      }),
      close: jest.fn(() => Promise.resolve()),
    };
    openMock.mockImplementation((target: string) => {
      openedPaths.push(target);
      return Promise.resolve(handle);
    });
    readFileMock.mockImplementation(() => Promise.resolve(owner));
    unlinkMock.mockResolvedValue(undefined);

    await withMarketplaceRefreshLock(() => Promise.resolve());

    expect(openedPaths.length).toBeGreaterThan(0);
    expect(
      openedPaths.every((lockPath) =>
        lockPath.startsWith('/mock/data/locks/marketplace-refresh/'),
      ),
    ).toBe(true);
  });

  it('rejects a symlinked reclaim directory before reading its owner', async () => {
    const staleOwner = JSON.stringify({
      version: 1,
      pid: 99_999_999,
      nonce: 'stale-owner',
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    openMock.mockRejectedValue(
      Object.assign(new Error('exists'), { code: 'EEXIST' }),
    );
    readFileMock.mockResolvedValue(staleOwner);
    mkdirMock.mockImplementation((target: string) =>
      target.endsWith('.reclaim')
        ? Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }))
        : Promise.resolve(),
    );
    lstatMock.mockImplementation((target: string) =>
      Promise.resolve({
        isDirectory: () => !target.endsWith('.lock'),
        isFile: () => target.endsWith('.lock'),
        isSymbolicLink: () => target.endsWith('.reclaim'),
        mode: target.endsWith('.lock') ? 0o600 : 0o700,
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      }),
    );
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 99_999_999) {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }
      return true;
    });

    try {
      await expect(
        withMarketplaceRefreshLock(() => Promise.resolve()),
      ).rejects.toThrow(/symbolic link/i);
    } finally {
      killSpy.mockRestore();
    }
    expect(
      readFileMock.mock.calls.some(([target]) =>
        String(target).endsWith('.reclaim/owner.json'),
      ),
    ).toBe(false);
  });
});
