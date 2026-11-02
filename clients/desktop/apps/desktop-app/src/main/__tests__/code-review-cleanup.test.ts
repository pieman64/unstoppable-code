/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type */
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type * as RegistryModule from '../lib/code-review-registry';

const calls: string[] = [];
const targets = {
  'opaque-a': { projectId: 'a', worktreeId: 'main' },
  'opaque-b': { projectId: 'b', worktreeId: 'main' },
  'opaque-c': { projectId: 'a', worktreeId: 'other' },
};
const list = jest.fn(
  async (): Promise<Record<string, RegistryModule.CodeReviewTargetRef>> =>
    targets,
);
const remove = jest.fn(async (id: string) => {
  calls.push(`registry:${id}`);
});
const stop = jest.fn(async (_project: string, id: string) => {
  calls.push(`stop:${id}`);
});
const deleteScope = jest.fn(async ({ worktreeId }: { worktreeId: string }) => {
  calls.push(`storage:${worktreeId}`);
});
const deleteSearchDocs = jest.fn();
const purgeObservability = jest.fn<Promise<void>, unknown[]>(
  async (): Promise<void> => undefined,
);
const cleanupPluginDirs = jest.fn();
const removeDataDirectory = jest.fn<Promise<void>, unknown[]>(
  async (): Promise<void> => {
    calls.push('data-directory');
  },
);
jest.mock('../lib/code-review-registry', () => ({
  listCodeReviewTargets: () => list(),
  removeCodeReviewTarget: (id: string) => remove(id),
}));
jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: (project: string, id: string) => stop(project, id),
  purgeLiveWorktreeObservabilityData: (...args: unknown[]): Promise<void> =>
    purgeObservability(...args),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({ deleteScope }),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: () => ({ deleteWorktreeDocs: deleteSearchDocs }),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: (...args: unknown[]): unknown =>
    cleanupPluginDirs(...args),
}));
jest.mock('../lib/paths', () => ({
  getCodeReviewRegistryFilePath: () => '/fake/registry.json',
  getWorktreeAttachmentsDir: () => '/fake/attachments',
  getWorktreeDataRootDir: () => '/fake/data',
}));
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: (...args: unknown[]): Promise<void> =>
    removeDataDirectory(...args),
}));
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { readFile, rm } from 'node:fs/promises';
import { removeCodeReviewChatsForWorktree } from '../lib/code-review-cleanup';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';

const actualRegistry = jest.requireActual<typeof RegistryModule>(
  '../lib/code-review-registry',
);

function expectNoTeardown(): void {
  expect(calls).toEqual([]);
  for (const effect of [
    stop,
    deleteScope,
    deleteSearchDocs,
    purgeObservability,
    cleanupPluginDirs,
    rm,
    removeDataDirectory,
    remove,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});
it('uses stored owner ids, drains before canonical storage deletion, and removes ownership last', async () => {
  expect(await removeCodeReviewChatsForWorktree('a', 'main')).toEqual([]);
  expect(stop).toHaveBeenCalledWith(CODE_REVIEW_CHAT_PROJECT_ID, 'opaque-a');
  expect(calls).toEqual([
    'stop:opaque-a',
    'storage:opaque-a',
    'data-directory',
    'registry:opaque-a',
  ]);
  expect(deleteScope).toHaveBeenCalledTimes(1);
});
it('retains the registry and storage when live teardown fails so deletion can retry safely', async () => {
  stop.mockRejectedValueOnce(new Error('session still alive'));
  expect(await removeCodeReviewChatsForWorktree('a', 'main')).toEqual([
    expect.stringContaining('session still alive'),
  ]);
  expect(deleteScope).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
it('continues durable cleanup when derived search deletion fails', async () => {
  deleteSearchDocs.mockRejectedValueOnce(
    new Error('Search index worker is closing'),
  );

  expect(await removeCodeReviewChatsForWorktree('a', 'main')).toEqual([]);
  expect(deleteScope).toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('opaque-a');
});

it('rejects unknown ownership before any teardown instead of reporting an empty sweep', async () => {
  list.mockRejectedValueOnce(new Error('registry unreadable'));
  await expect(removeCodeReviewChatsForWorktree('a', 'main')).rejects.toThrow(
    'registry unreadable',
  );
  expectNoTeardown();
});
it('returns a warning after removal persistence fails and retries on the next sweep', async () => {
  remove.mockRejectedValueOnce(new Error('registry write failed'));
  expect(await removeCodeReviewChatsForWorktree('a', 'main')).toEqual([
    expect.stringContaining('registry write failed'),
  ]);
  expect(await removeCodeReviewChatsForWorktree('a', 'main')).toEqual([]);
  expect(remove).toHaveBeenCalledTimes(2);
});

it.each([
  ['invalid JSON', '{'],
  ['malformed ownership', '{"version":1,"targets":{"opaque-a":null}}'],
  [
    'valid ownership followed by a malformed row',
    JSON.stringify({ version: 1, targets: { ...targets, invalid: null } }),
  ],
  ['future version', '{"version":2,"targets":{}}'],
])(
  'rejects actual registry %s before deleting any review data',
  async (_label, raw) => {
    jest.mocked(readFile).mockResolvedValueOnce(raw);
    list.mockImplementationOnce(actualRegistry.listCodeReviewTargets);

    await expect(
      removeCodeReviewChatsForWorktree('a', 'main'),
    ).rejects.toThrow();

    expect(readFile).toHaveBeenCalledWith('/fake/registry.json', 'utf8');
    expectNoTeardown();
  },
);

it('preserves review data when actual registry ownership cannot be read', async () => {
  const failure = Object.assign(new Error('registry read denied'), {
    code: 'EACCES',
  });
  jest.mocked(readFile).mockRejectedValueOnce(failure);
  list.mockImplementationOnce(actualRegistry.listCodeReviewTargets);

  await expect(removeCodeReviewChatsForWorktree('a', 'main')).rejects.toBe(
    failure,
  );

  expectNoTeardown();
});

it.each(['absent', 'empty'])(
  'accepts an %s registry as an empty cleanup sweep',
  async (state) => {
    if (state === 'absent') {
      jest
        .mocked(readFile)
        .mockRejectedValueOnce(
          Object.assign(new Error('missing registry'), { code: 'ENOENT' }),
        );
    } else {
      jest.mocked(readFile).mockResolvedValueOnce('{"version":1,"targets":{}}');
    }
    list.mockImplementationOnce(actualRegistry.listCodeReviewTargets);

    await expect(
      removeCodeReviewChatsForWorktree('a', 'main'),
    ).resolves.toEqual([]);

    expectNoTeardown();
  },
);

it('cleans only matching ownership from a supported on-disk registry', async () => {
  jest
    .mocked(readFile)
    .mockResolvedValueOnce(JSON.stringify({ version: 1, targets }));
  list.mockImplementationOnce(actualRegistry.listCodeReviewTargets);

  await expect(removeCodeReviewChatsForWorktree('a', 'main')).resolves.toEqual(
    [],
  );

  expect(calls).toEqual([
    'stop:opaque-a',
    'storage:opaque-a',
    'data-directory',
    'registry:opaque-a',
  ]);
  const scope = {
    projectId: CODE_REVIEW_CHAT_PROJECT_ID,
    worktreeId: 'opaque-a',
  };
  expect(deleteScope).toHaveBeenCalledTimes(1);
  expect(deleteScope).toHaveBeenCalledWith(scope);
  for (const effect of [
    stop,
    deleteSearchDocs,
    purgeObservability,
    cleanupPluginDirs,
  ]) {
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith(scope.projectId, scope.worktreeId);
  }
  expect(rm).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledWith('/fake/attachments', {
    recursive: true,
    force: true,
  });
  expect(removeDataDirectory).toHaveBeenCalledTimes(1);
  expect(removeDataDirectory).toHaveBeenCalledWith(
    scope.projectId,
    scope.worktreeId,
    { worktreeDataRootDir: '/fake/data', removeTree: removeTreeWithoutAsar },
  );
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('opaque-a');
});
