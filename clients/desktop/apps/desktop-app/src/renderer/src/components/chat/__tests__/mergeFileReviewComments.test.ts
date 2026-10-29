import { mergeFileReviewComments } from '../mergeFileReviewComments';
import type { UseFileComments } from '../useFileComments';
import type { UseReviewComments } from '../../code-review/useReviewComments';
import type { ReviewCommentThread } from '@canopy/desktop-shared/types';

function fixtures(view: 'file' | 'diff'): {
  file: UseFileComments;
  review: UseReviewComments;
  published: string[];
} {
  const published: string[] = [];
  const thread: ReviewCommentThread = {
    id: 'legacy',
    status: 'open',
    createdAt: 'now',
    anchorState: 'matched',
    anchor: {
      source: 'code',
      filePath: 'file.ts',
      side: 'old',
      quote: 'removed',
    },
    comments: [
      {
        id: 'draft',
        author: 'user',
        body: 'question',
        createdAt: 'now',
        staged: true,
      },
    ],
  };
  const file = {
    view,
    document: { filePath: '/file.ts', annotations: [], commentThreads: [] },
    otherViewCount: 2,
    stagedCount: 1,
    addReply: jest.fn(),
    toggleResolved: jest.fn(),
    editStagedComment: jest.fn(),
    deleteStagedComment: jest.fn(),
    addComment: jest.fn(),
    discussAnnotation: jest.fn(),
    dismissAnnotation: jest.fn(),
    submit: async (send): Promise<void> => {
      if (
        await send('file draft', {
          kind: 'file-comment-instructions',
          text: 'instructions',
        })
      )
        published.push('file');
    },
  } satisfies UseFileComments;
  const review = {
    threads: [thread],
    stagedCount: 1,
    addCodeComment: jest.fn(),
    addDiagramComment: jest.fn(),
    addGeneralComment: jest.fn(),
    addReply: jest.fn(),
    editStagedComment: jest.fn(),
    deleteStagedComment: jest.fn(),
    toggleResolved: jest.fn(),
    submit: async (send): Promise<void> => {
      if (
        await send('legacy draft', {
          kind: 'file-comment-instructions',
          text: 'instructions',
        })
      )
        published.push('legacy');
    },
  } satisfies UseReviewComments;
  return { file, review, published };
}
it('includes legacy code threads in the shared drawer, retaining view-specific markers and storage ownership', async () => {
  const { file, review, published } = fixtures('file');
  const comments = mergeFileReviewComments(file, review);
  expect(comments.otherViewCount).toBe(2);
  expect(comments.document.commentThreads).toEqual([]);
  expect(comments.drawerThreads?.[0]?.id).toBe('legacy');
  await comments.submit(jest.fn().mockResolvedValue(true));
  expect(published).toEqual(['file', 'legacy']);
  const diff = mergeFileReviewComments({ ...file, view: 'diff' }, review);
  expect(diff.document.commentThreads[0]).toMatchObject({
    id: 'legacy',
    anchorState: 'outdated',
    anchor: { view: 'diff', side: 'old' },
  });
  diff.addReply('legacy', 'reply');
  expect(review.addReply).toHaveBeenCalledWith('legacy', 'reply');
  expect(file.addReply).not.toHaveBeenCalled();
});
it('uses one accepted dispatch for both stores and leaves both staged on rejection', async () => {
  const { file, review, published } = fixtures('diff');
  const comments = mergeFileReviewComments(file, review);
  const send = jest.fn().mockResolvedValue(false);
  await comments.submit(send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    'file draft\n\nlegacy draft',
    expect.anything(),
  );
  expect(published).toEqual([]);
  send.mockResolvedValue(true);
  await comments.submit(send);
  expect(published).toEqual(['file', 'legacy']);
});
