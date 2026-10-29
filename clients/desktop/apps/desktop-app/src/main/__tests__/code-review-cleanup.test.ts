/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type */
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';

const calls: string[] = [];
const targets = {
  'opaque-a': { projectId: 'a', worktreeId: 'main' },
  'opaque-b': { projectId: 'b', worktreeId: 'main' },
};
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
jest.mock('../lib/code-review-registry', () => ({
  listCodeReviewTargets: async () => targets,
  removeCodeReviewTarget: (id: string) => remove(id),
}));
jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: (project: string, id: string) => stop(project, id),
  purgeLiveWorktreeObservabilityData: async () => undefined,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({ deleteScope }),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: () => ({ deleteWorktreeDocs: deleteSearchDocs }),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: async () => undefined,
}));
jest.mock('../lib/paths', () => ({
  getWorktreeAttachmentsDir: () => '/fake/attachments',
  getWorktreeDataRootDir: () => '/fake/data',
}));
jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: async () => undefined,
}));
jest.mock('node:fs/promises', () => ({
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { removeCodeReviewChatsForWorktree } from '../lib/code-review-cleanup';

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
