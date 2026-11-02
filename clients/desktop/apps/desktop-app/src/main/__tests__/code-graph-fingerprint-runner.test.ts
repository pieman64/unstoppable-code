import { EventEmitter } from 'node:events';

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn(() => true);
}

const resolveGitMock = jest.fn<Promise<string>, []>();
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> => resolveGitMock(),
}));

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

jest.mock('../lib/code-graph-availability', () => ({
  getCodeGraphGenerationTimeoutMs: (): number => 30_000,
}));

import {
  cancelCodeGraphFingerprint,
  resetCodeGraphFingerprintRunnerForTests,
  runCodeGraphWorkerFingerprint,
  CodeGraphFingerprintWorkerError,
} from '../code-graph/fingerprint-runner';

const REPOSITORIES = [{ repoId: 'repo', rootPath: '/worktree' }];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('code-graph fingerprint runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetCodeGraphFingerprintRunnerForTests();
    forkMock.mockReset();
    resolveGitMock.mockReset().mockResolvedValue('/verified/bin/git');
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    const cancellations = ['one', 'two', 'same'].map((key) =>
      cancelCodeGraphFingerprint(key),
    );
    for (const child of children) child.emit('exit', 0);
    await Promise.all(cancellations);
  });

  it('forks a one-shot utility process and returns its fingerprint', async () => {
    const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
    void pending.catch(() => {});
    await Promise.resolve();

    expect(forkMock).toHaveBeenCalledTimes(1);
    const forkCall = forkMock.mock.calls[0];
    expect(forkCall?.[0]).toEqual(
      expect.stringContaining('code-graph-fingerprint-worker.js'),
    );
    expect(forkCall?.[1]).toEqual([]);
    const options = forkCall?.[2];
    expect(isRecord(options)).toBe(true);
    if (!isRecord(options)) throw new Error('Missing utility process options');
    expect(options.serviceName).toBe('code-graph-fingerprint');
    const env = options.env;
    expect(isRecord(env)).toBe(true);
    if (!isRecord(env)) throw new Error('Missing utility process environment');
    expect(env.CANOPY_GIT_EXECUTABLE).toBe('/verified/bin/git');
    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      repositories: REPOSITORIES,
    });

    children[0]?.emit('message', {
      data: { ok: true, fingerprint: 'fingerprint-1' },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      fingerprint: 'fingerprint-1',
    });
  });

  it('serializes different worktrees and coalesces the same worktree', async () => {
    const first = runCodeGraphWorkerFingerprint('same', REPOSITORIES);
    const duplicate = runCodeGraphWorkerFingerprint('same', REPOSITORIES);
    const second = runCodeGraphWorkerFingerprint('two', REPOSITORIES);
    await Promise.resolve();
    expect(first).toBe(duplicate);
    expect(children).toHaveLength(1);

    children[0]?.emit('message', {
      data: { ok: true, fingerprint: 'first' },
    });
    await expect(first).resolves.toEqual({ ok: true, fingerprint: 'first' });
    await expect(duplicate).resolves.toEqual({
      ok: true,
      fingerprint: 'first',
    });
    expect(children).toHaveLength(2);

    children[1]?.emit('message', {
      data: { ok: true, fingerprint: 'second' },
    });
    await expect(second).resolves.toEqual({
      ok: true,
      fingerprint: 'second',
    });
  });

  it('kills a fingerprint worker canceled before it spawned once it spawns', async () => {
    const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
    void pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    const child = children[0];
    if (!child) throw new Error('No fingerprint worker forked');
    // Before launch a kill reaches nothing, as Electron's does.
    child.kill.mockReturnValue(false);

    const canceled = cancelCodeGraphFingerprint('one');
    await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.kill.mockReturnValue(true);
    child.emit('spawn');
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit('exit', 0);
    await canceled;
  });

  it('kills and rejects an active fingerprint on cancellation', async () => {
    const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
    void pending.catch(() => {});
    await Promise.resolve();
    const canceling = cancelCodeGraphFingerprint('one');

    await expect(
      pending,
    ).rejects.toMatchObject<CodeGraphFingerprintWorkerError>(
      new CodeGraphFingerprintWorkerError(
        'canceled',
        'Code-graph fingerprint for "one" was canceled.',
      ),
    );
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    children[0]?.emit('exit', 0);
    await expect(canceling).resolves.toBeUndefined();
  });

  it('preserves the exit wait for a repeat cancel after fire-and-forget cancellation', async () => {
    const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
    void pending.catch(() => {});
    await Promise.resolve();
    void cancelCodeGraphFingerprint('one');
    await expect(pending).rejects.toMatchObject({ reason: 'canceled' });

    let settled = false;
    const repeated = cancelCodeGraphFingerprint('one').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    children[0]?.emit('exit', 0);
    await repeated;
    expect(settled).toBe(true);
  });

  it('rejects malformed worker responses and terminates that worker', async () => {
    const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
    void pending.catch(() => {});
    await Promise.resolve();
    children[0]?.emit('message', { data: { unexpected: true } });

    await expect(pending).rejects.toMatchObject({
      reason: 'malformed-response',
    });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('kills a fingerprint that exceeds its watchdog', async () => {
    jest.useFakeTimers();
    try {
      const pending = runCodeGraphWorkerFingerprint('one', REPOSITORIES);
      void pending.catch(() => {});
      await Promise.resolve();
      jest.advanceTimersByTime(30_000);

      await expect(pending).rejects.toMatchObject({ reason: 'timeout' });
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      children[0]?.emit('exit', 0);
    } finally {
      jest.useRealTimers();
    }
  });
});
