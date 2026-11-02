import { EventEmitter } from 'node:events';
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('../lib/code-review-persistence', () => ({
  readCodeReviewState: jest.fn(),
  saveCodeReviewComments: jest.fn(),
}));

jest.mock('../lib/code-review-diff', () => ({
  listReviewRepos: jest.fn(),
  computeReviewFingerprint: jest.fn(),
}));

jest.mock('../lib/code-review-scheduler', () => ({
  armCodeReview: jest.fn(),
  requestManualCodeReviewRefresh: jest.fn(),
  setCodeReviewModalOpen: jest.fn(),
}));

jest.mock('../lib/code-review-registry', () => ({
  registerCodeReviewTarget: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
}));

import {
  IPC_CHANNELS,
  type CodeReviewFile,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  readCodeReviewState,
  saveCodeReviewComments,
} from '../lib/code-review-persistence';
import {
  computeReviewFingerprint,
  listReviewRepos,
} from '../lib/code-review-diff';
import {
  armCodeReview,
  requestManualCodeReviewRefresh,
  setCodeReviewModalOpen,
} from '../lib/code-review-scheduler';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import { registerCodeReviewHandlers } from '../ipc/code-review';

const mockedReadCodeReviewState = jest.mocked(readCodeReviewState);
const mockedSaveCodeReviewComments = jest.mocked(saveCodeReviewComments);
const mockedComputeReviewFingerprint = jest.mocked(computeReviewFingerprint);
const mockedListReviewRepos = jest.mocked(listReviewRepos);
const mockedArmCodeReview = jest.mocked(armCodeReview);
const mockedRequestManualCodeReviewRefresh = jest.mocked(
  requestManualCodeReviewRefresh,
);
const mockedSetCodeReviewModalOpen = jest.mocked(setCodeReviewModalOpen);
const mockedRegisterCodeReviewTarget = jest.mocked(registerCodeReviewTarget);
const mockedValidateId = jest.mocked(validateId);
const mockedSendToWindow = jest.mocked(sendToAllWindows);

function emptyReview(): CodeReviewFile {
  return { version: 1, armed: false, commentThreads: [], diagrams: {} };
}

describe('registerCodeReviewHandlers', () => {
  beforeAll(() => {
    registerCodeReviewHandlers(() => null);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('codeReviewGet returns { review, fingerprint }', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewGet);
    expect(handler).toBeDefined();

    const review = emptyReview();
    mockedReadCodeReviewState.mockResolvedValue(review);
    mockedListReviewRepos.mockResolvedValue([
      { repoId: 'default', repoPath: '/repo' },
    ]);
    mockedComputeReviewFingerprint.mockResolvedValue('fp-1');

    const result = await handler?.(
      {},
      { projectId: 'proj-1', worktreeId: 'wt-1' },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedReadCodeReviewState).toHaveBeenCalledWith('proj-1', 'wt-1');
    expect(mockedListReviewRepos).toHaveBeenCalledWith('proj-1', 'wt-1');
    expect(mockedComputeReviewFingerprint).toHaveBeenCalledWith([
      { repoId: 'default', repoPath: '/repo' },
    ]);
    expect(result).toEqual({ review, fingerprint: 'fp-1' });
  });

  it('codeReviewArm calls armCodeReview with the scope', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewArm);
    expect(handler).toBeDefined();

    mockedArmCodeReview.mockResolvedValue({ status: 'fresh' });

    const result = await handler?.(
      {},
      { projectId: 'proj-1', worktreeId: 'wt-1' },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedArmCodeReview).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'wt-1' },
      expect.any(Function),
    );
    expect(result).toEqual({ status: 'fresh' });
  });

  it('codeReviewGenerate calls requestManualCodeReviewRefresh with the scope', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewGenerate);
    expect(handler).toBeDefined();

    mockedRequestManualCodeReviewRefresh.mockResolvedValue({
      status: 'generated',
    });

    const result = await handler?.(
      {},
      { projectId: 'proj-1', worktreeId: 'wt-1' },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedRequestManualCodeReviewRefresh).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'wt-1' },
      expect.any(Function),
    );
    expect(result).toEqual({ status: 'generated' });
  });

  it('codeReviewSaveComments persists and broadcasts codeReviewUpdated', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewSaveComments);
    expect(handler).toBeDefined();

    const commentThreads: ReviewCommentThread[] = [];
    const updated: CodeReviewFile = { ...emptyReview(), armed: true };
    mockedSaveCodeReviewComments.mockResolvedValue(updated);
    mockedListReviewRepos.mockResolvedValue([
      { repoId: 'default', repoPath: '/repo' },
    ]);
    mockedComputeReviewFingerprint.mockResolvedValue('fp-save');

    const request = {
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      commentThreads,
    };
    const result = await handler?.({}, request);

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedSaveCodeReviewComments).toHaveBeenCalledWith(request);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      IPC_CHANNELS.codeReviewUpdated,
      {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        fingerprint: 'fp-save',
        review: updated,
      },
    );
    expect(result).toBe(updated);
  });

  it('codeReviewSaveComments does not broadcast when saveCodeReviewComments returns null', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewSaveComments);
    expect(handler).toBeDefined();

    mockedSaveCodeReviewComments.mockResolvedValue(null);

    const result = await handler?.(
      {},
      { projectId: 'proj-1', worktreeId: 'wt-1', commentThreads: [] },
    );

    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('releases only a destroyed renderer’s active panel visibility leases', async () => {
    const sender = new EventEmitter();
    const handler = handlers.get(IPC_CHANNELS.codeReviewModalOpen);
    const scope = { projectId: 'p', worktreeId: 'w' };
    await handler?.({ sender }, { ...scope, open: true, consumerId: 'first' });
    await handler?.({ sender }, { ...scope, open: true, consumerId: 'second' });
    await handler?.({ sender }, { ...scope, open: false, consumerId: 'first' });
    jest.mocked(setCodeReviewModalOpen).mockClear();
    sender.emit('destroyed');
    expect(setCodeReviewModalOpen).toHaveBeenCalledTimes(1);
    expect(setCodeReviewModalOpen).toHaveBeenCalledWith(
      expect.objectContaining(scope),
      false,
      expect.any(Function),
      'second',
    );
  });

  it('codeReviewRegister validates ids and writes the registry', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewRegister);
    expect(handler).toBeDefined();

    mockedRegisterCodeReviewTarget.mockResolvedValue(undefined);

    await handler?.({}, { worktreeId: 'wt-1', projectId: 'proj-1' });

    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    // The handler stores the target under the composite scope key with both
    // real ids in the ref.
    expect(mockedRegisterCodeReviewTarget).toHaveBeenCalledWith(
      'proj-1--wt-1',
      {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
      },
    );
  });

  it('codeReviewRegister propagates persistence rejection', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewRegister);
    expect(handler).toBeDefined();
    const error = new Error('registry persistence failed');
    mockedRegisterCodeReviewTarget.mockRejectedValueOnce(error);
    await expect(
      handler?.({}, { projectId: 'proj-1', worktreeId: 'wt-1' }),
    ).rejects.toBe(error);
  });

  it('codeReviewModalOpen calls setCodeReviewModalOpen', async () => {
    const handler = handlers.get(IPC_CHANNELS.codeReviewModalOpen);
    expect(handler).toBeDefined();

    await handler?.(
      {},
      { projectId: 'proj-1', worktreeId: 'wt-1', open: true },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedSetCodeReviewModalOpen).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'wt-1', open: true },
      true,
      expect.any(Function),
      undefined,
    );
  });
});
