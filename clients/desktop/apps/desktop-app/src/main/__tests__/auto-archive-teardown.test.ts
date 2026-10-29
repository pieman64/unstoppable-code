jest.mock('../services/scripts-service', () => ({
  cancelWorktreeSetup: jest.fn(() => Promise.resolve()),
  runScript: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

import { cancelWorktreeSetup, runScript } from '../services/scripts-service';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { runAutoArchiveTeardown } from '../lib/auto-archive-teardown';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  isWorkspaceTargetAutoArchiveTeardown,
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
  withWorkspaceTargetArchiveDrain,
  reserveWorkspaceTargetRuntimeStart,
  withWorkspaceTargetRuntimePreparation,
} from '../lib/workspace-target-exclusion';

beforeEach(() => {
  jest.clearAllMocks();
  resetWorkspaceTargetExclusionsForTests();
  jest.mocked(runScript).mockResolvedValue({
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 1,
  });
  jest
    .mocked(readWorkspaceConfig)
    .mockResolvedValue({ repos: [{ id: 'api' }, { id: 'web' }] } as never);
});

test('manual archive fences script and terminal admission and releases the fence on failure', async () => {
  await expect(
    withWorkspaceTargetArchiveDrain('workspace', 'tree', () => {
      expect(() =>
        assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
      ).toThrow('being archived');
      expect(() =>
        reserveWorkspaceTargetRuntimeStart('workspace', 'tree'),
      ).toThrow('being archived');
      expect(() =>
        assertWorkspaceTargetRuntimeStartAllowed('workspace', 'another'),
      ).not.toThrow();
      return Promise.reject(new Error('locked'));
    }),
  ).rejects.toThrow('locked');
  expect(() =>
    assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
  ).not.toThrow();
});

test('manual archive waits for an already-admitted runtime start before cleanup', async () => {
  const release = reserveWorkspaceTargetRuntimeStart('workspace', 'tree');
  let cleanupStarted = false;
  const archive = withWorkspaceTargetArchiveDrain('workspace', 'tree', () => {
    cleanupStarted = true;
    return Promise.resolve();
  });

  await Promise.resolve();
  expect(cleanupStarted).toBe(false);
  expect(() => reserveWorkspaceTargetRuntimeStart('workspace', 'tree')).toThrow(
    'being archived',
  );

  release();
  await expect(archive).resolves.toBeUndefined();
  expect(cleanupStarted).toBe(true);
});

test('manual archive fails safely when an admitted runtime start does not drain', async () => {
  jest.useFakeTimers();
  const release = reserveWorkspaceTargetRuntimeStart('workspace', 'tree');
  try {
    const archive = withWorkspaceTargetArchiveDrain('workspace', 'tree', () =>
      Promise.resolve(),
    );
    const assertion = expect(archive).rejects.toThrow(
      'runtime start in progress',
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(() =>
      assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
    ).not.toThrow();
  } finally {
    release();
    jest.useRealTimers();
  }
});

test('setup that was still resolving before archive cannot spawn after the archive fence reopens', async () => {
  let resume: (() => void) | undefined;
  const prepared = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const setup = withWorkspaceTargetRuntimePreparation(
    'workspace',
    'tree',
    async () => {
      await prepared;
      assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree');
    },
  );
  const assertion = expect(setup).rejects.toThrow('cancelled by archiving');
  await withWorkspaceTargetArchiveDrain('workspace', 'tree', () =>
    Promise.resolve(undefined),
  );
  if (!resume) throw new Error('Expected setup preparation gate');
  resume();
  await assertion;
  await expect(
    withWorkspaceTargetRuntimePreparation('workspace', 'tree', () => {
      assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree');
      return Promise.resolve();
    }),
  ).resolves.toBeUndefined();
});

test('the archive fence still permits the exclusively owned Auto Delete teardown', async () => {
  await withWorkspaceTargetAutoArchiveLease('workspace', 'tree', () =>
    withWorkspaceTargetArchiveDrain('workspace', 'tree', () =>
      withWorkspaceTargetAutoArchiveTeardown('workspace', 'tree', () => {
        expect(() =>
          assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
        ).not.toThrow();
        return Promise.resolve();
      }),
    ),
  );
});

test('runs the single-repo configured teardown through the scripts service', async () => {
  await runAutoArchiveTeardown('workspace', 'tree', false);
  expect(runScript).toHaveBeenCalledTimes(1);
  expect(runScript).toHaveBeenCalledWith({
    target: 'project',
    projectId: 'workspace',
    worktreeId: 'tree',
    scriptName: 'teardown',
  });
});

test('cancels the running setup before the first teardown script starts', async () => {
  let finishCancel!: () => void;
  jest.mocked(cancelWorktreeSetup).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCancel = resolve;
      }),
  );
  const operation = runAutoArchiveTeardown('workspace', 'tree', false);
  await Promise.resolve();
  expect(cancelWorktreeSetup).toHaveBeenCalledWith({
    projectId: 'workspace',
    worktreeId: 'tree',
  });
  expect(runScript).not.toHaveBeenCalled();
  finishCancel();
  await operation;
  expect(runScript).toHaveBeenCalledTimes(1);
});

test('waits for every repository before after-teardown', async () => {
  const finish: Array<() => void> = [];
  jest.mocked(runScript).mockImplementation(async (request) => {
    if (request.target === 'workspace-repo')
      await new Promise<void>((resolve) => finish.push(resolve));
    return {
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1,
    };
  });
  const operation = runAutoArchiveTeardown('workspace', 'tree', true);
  for (let i = 0; i < 10 && finish.length < 2; i++) await Promise.resolve();
  expect(finish).toHaveLength(2);
  expect(
    jest.mocked(runScript).mock.calls.map(([request]) => request.scriptName),
  ).toEqual(['before-teardown', 'teardown', 'teardown']);
  finish[0]();
  await Promise.resolve();
  expect(runScript).toHaveBeenCalledTimes(3);
  finish[1]();
  await operation;
  expect(jest.mocked(runScript).mock.calls[3]?.[0].scriptName).toBe(
    'after-teardown',
  );
});

test.each(['before-teardown', 'teardown', 'after-teardown'])(
  'rejects unsuccessful %s without hiding failure',
  async (scriptName) => {
    jest.mocked(runScript).mockImplementation((request) =>
      Promise.resolve({
        success: request.scriptName !== scriptName,
        exitCode: 1,
        output: 'cleanup failed',
        timedOut: false,
        durationMs: 1,
      }),
    );
    await expect(
      runAutoArchiveTeardown('workspace', 'tree', true),
    ).rejects.toThrow('cleanup failed');
    if (scriptName !== 'after-teardown')
      expect(
        jest
          .mocked(runScript)
          .mock.calls.some(
            ([request]) => request.scriptName === 'after-teardown',
          ),
      ).toBe(false);
  },
);

test('teardown permission is limited to its async scope and disappears after failure', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operation = withWorkspaceTargetAutoArchiveLease(
    'workspace',
    'tree',
    () =>
      withWorkspaceTargetAutoArchiveTeardown('workspace', 'tree', async () => {
        assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree');
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error('teardown failure');
      }),
  );
  await ready;
  expect(isWorkspaceTargetAutoArchiveTeardown('workspace\0tree')).toBe(true);
  expect(() =>
    assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
  ).toThrow('automatically deleted');
  release();
  await expect(operation).rejects.toThrow('teardown failure');
  expect(isWorkspaceTargetAutoArchiveTeardown('workspace\0tree')).toBe(false);
  expect(() =>
    assertWorkspaceTargetRuntimeStartAllowed('workspace', 'tree'),
  ).not.toThrow();
  await expect(
    withWorkspaceTargetAutoArchiveTeardown('workspace', 'tree', () =>
      Promise.resolve(undefined),
    ),
  ).rejects.toThrow('requires its exclusive deletion lease');
});
