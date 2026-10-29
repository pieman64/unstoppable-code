import {
  composeReviewCommentSubmitHiddenContext,
  composeReviewCommentSubmitMessage,
} from '../useReviewComments';
import type { ReviewCommentThread } from '@canopy/desktop-shared/types';

const codeThread: ReviewCommentThread = {
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-07-07T00:00:00.000Z',
  anchor: {
    source: 'code',
    quote: 'const retries = 3;',
    repoId: 'repo-a',
    filePath: 'src/net/client.ts',
    side: 'new',
    lineStart: 41,
    lineEnd: 41,
  },
  anchorState: 'matched',
  comments: [
    {
      id: 'c1',
      author: 'user',
      body: 'Why three retries?',
      createdAt: '2026-07-07T00:00:00.000Z',
      staged: true,
    },
  ],
};

describe('composeReviewCommentSubmitMessage', () => {
  it('formats code-anchored threads with ids, location, and fenced quote', () => {
    const message = composeReviewCommentSubmitMessage([codeThread]);
    expect(message).toContain('1 comment thread');
    expect(message).toContain('thread-1');
    expect(message).toContain('repo-a/src/net/client.ts:41');
    expect(message).toContain('const retries = 3;');
    expect(message).toContain('Comment: Why three retries?');
    expect(message).not.toContain('Request: Why three retries?');
    expect(message).toContain('Why three retries?');
  });

  it('skips resolved threads and threads without pending comments', () => {
    const resolved: ReviewCommentThread = {
      ...codeThread,
      id: 'thread-2',
      status: 'resolved',
    };
    const submitted: ReviewCommentThread = {
      ...codeThread,
      id: 'thread-3',
      comments: [{ ...codeThread.comments[0], id: 'c2', staged: false }],
    };
    expect(composeReviewCommentSubmitMessage([resolved, submitted])).toBe('');
  });

  it('keeps ambiguous-comment guidance in hidden context', () => {
    const hiddenContext = composeReviewCommentSubmitHiddenContext();

    expect(hiddenContext.kind).toBe('file-comment-instructions');
    expect(hiddenContext.text).toContain('do not assume changes are requested');
  });
});
