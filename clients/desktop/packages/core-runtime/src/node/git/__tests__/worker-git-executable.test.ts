import {
  WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitExecutableGetResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  createWorkerGitExecutableHandlers,
  type WorkerGitExecutableHost,
  type WorkerGitExecutableObservation,
} from '../worker-git-executable';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};

const READY: WorkerGitExecutableObservation = {
  status: {
    platform: 'darwin',
    required: true,
    ready: true,
    version: 'git version 2.47.1',
    source: 'auto-detected',
    wingetAvailable: false,
    checkedAt: '2026-10-26T12:00:00.000Z',
  },
  issue: null,
};

function host(
  detect: WorkerGitExecutableHost['detect'],
): WorkerGitExecutableHost {
  return { authorityId: 'local-desktop', detect };
}

function dispatcher(
  gitHost: WorkerGitExecutableHost,
): CanopyDispatcher<typeof WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
    handlers: createWorkerGitExecutableHandlers(gitHost),
  });
}

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('Expected the query to fail');
}

describe('worker.git.executable.get handler', () => {
  it('passes recheck to the host and returns only codes and facts', async () => {
    const requests: Array<{ recheck: boolean }> = [];
    const result = await dispatcher(
      host((request) => {
        requests.push({ ...request });
        return Promise.resolve({
          // Extra host fields, such as the path, never reach the result.
          status: { ...READY.status, path: '/opt/homebrew/bin/git' },
          issue: null,
        });
      }),
    ).query(
      'worker.git.executable.get',
      { scope: {}, recheck: true },
      { caller },
    );

    expect(requests).toEqual([{ recheck: true }]);
    expect(result).toEqual({ ...READY.status, issue: null });
  });

  it('reports why Git is not ready, and no issue once it is', async () => {
    const missing: WorkerGitExecutableObservation = {
      status: {
        ...READY.status,
        ready: false,
        version: null,
        source: 'not-found',
      },
      issue: 'selected-unusable',
    };
    const query = (
      observation: WorkerGitExecutableObservation,
    ): Promise<WorkerGitExecutableGetResult> =>
      dispatcher(host(() => Promise.resolve(observation))).query(
        'worker.git.executable.get',
        { scope: { authorityId: 'local-desktop' }, recheck: false },
        { caller },
      );

    await expect(query(missing)).resolves.toMatchObject({
      ready: false,
      issue: 'selected-unusable',
    });
    await expect(query({ ...missing, issue: null })).resolves.toMatchObject({
      issue: 'not-found',
    });
    await expect(
      query({ ...READY, issue: 'candidate-unusable' }),
    ).resolves.toMatchObject({ ready: true, issue: null });
  });

  it.each([
    { authorityId: 'remote-desktop' },
    { targetId: 'in_process_worker' },
    { authorityId: 'local-desktop', targetId: 'remote' },
  ])('refuses %o before detecting', async (scope) => {
    const detect = jest.fn(() => Promise.resolve(READY));
    const error = await failure(
      dispatcher(host(detect)).query(
        'worker.git.executable.get',
        { scope, recheck: false },
        { caller },
      ),
    );

    expect(error.payload.kind).toBe('capability_unavailable');
    expect(detect).not.toHaveBeenCalled();
  });

  it('serves a host-enrolled target', async () => {
    await expect(
      dispatcher({
        authorityId: 'local-desktop',
        targetId: 'in_process_worker',
        detect: () => Promise.resolve(READY),
      }).query(
        'worker.git.executable.get',
        { scope: { targetId: 'in_process_worker' }, recheck: false },
        { caller },
      ),
    ).resolves.toMatchObject({ ready: true });
  });

  it('types a host failure and keeps the host error as its runtime cause', async () => {
    const cause = Object.assign(new Error('EIO: i/o error, read'), {
      code: 'EIO',
    });
    const error = await failure(
      dispatcher(host(() => Promise.reject(cause))).query(
        'worker.git.executable.get',
        { scope: {}, recheck: false },
        { caller },
      ),
    );

    expect(error.payload).toMatchObject({
      kind: 'internal',
      code: 'worker.git.executable.detectionFailed',
    });
    expect(error.payload.message).not.toContain('EIO');
    expect(error.runtimeCause).toBe(cause);
  });

  it('denies a caller without worker.git.read before detecting', async () => {
    const detect = jest.fn(() => Promise.resolve(READY));
    const error = await failure(
      dispatcher(host(detect)).query(
        'worker.git.executable.get',
        { scope: {}, recheck: false },
        { caller: { ...caller, grants: [] } },
      ),
    );

    expect(error.payload.kind).toBe('permission_denied');
    expect(detect).not.toHaveBeenCalled();
  });

  it('rejects params naming a path or workspace', async () => {
    const detect = jest.fn(() => Promise.resolve(READY));
    for (const params of [
      { scope: { workspaceId: 'ws' }, recheck: false },
      { scope: {}, recheck: false, path: '/usr/bin/git' },
    ]) {
      const error = await failure(
        dispatcher(host(detect)).query(
          'worker.git.executable.get',
          // @ts-expect-error -- the schema refuses what the type forbids.
          params,
          { caller },
        ),
      );
      expect(error.payload.kind).toBe('invalid_argument');
    }
    expect(detect).not.toHaveBeenCalled();
  });
});
