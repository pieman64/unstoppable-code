/** @jest-environment jsdom */

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileAnnotationDocument } from '@canopy/desktop-shared/types';
import {
  composeFileCommentSubmitMessage,
  markFileCommentsSubmitted,
  prepareFileCommentSubmit,
  useFileComments,
} from '../useFileComments';

global.IS_REACT_ACT_ENVIRONMENT = true;

describe('composeFileCommentSubmitMessage', () => {
  it('identifies old-side diff comments with their comparison instead of current-file coordinates', () => {
    const anchor = {
      source: 'code' as const,
      view: 'diff' as const,
      filePath: '/workspace/file.ts',
      repoId: 'repo-a',
      side: 'old' as const,
      lineStart: 12,
      lineEnd: 14,
      quote: 'removed code',
      diff: {
        source: 'uncommitted' as const,
        snapshotId: 'snapshot-123',
        previousPath: 'old.ts',
      },
    };
    const message = composeFileCommentSubmitMessage({
      filePath: anchor.filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'diff-thread',
          status: 'open',
          createdAt: '2026-09-17T00:00:00Z',
          anchorState: 'outdated',
          anchor,
          comments: [
            {
              id: 'draft',
              author: 'user',
              body: 'Keep this check.',
              createdAt: '2026-09-17T00:00:00Z',
              staged: true,
            },
          ],
        },
      ],
    });
    expect(message).toContain('Diff comment thread');
    expect(message).toContain('uncommitted');
    expect(message).toContain('snapshot-123');
    expect(message).toContain('old');
    expect(message).toContain('outdated');
    expect(message).toContain('repo-a');
    expect(message).toContain('old.ts');
  });

  it('includes staged open comments with stable thread and raw-line context', () => {
    const document: FileAnnotationDocument = {
      filePath: '/workspace/src/file.ts',
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/src/file.ts',
            side: 'new',
            lineStart: 4,
            lineEnd: 5,
            quote: 'const value = one;\nreturn value;',
          },
          comments: [
            {
              id: 'agent-1',
              author: 'agent',
              body: 'Please inspect this.',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: false,
            },
            {
              id: 'user-1',
              author: 'user',
              body: 'Use the safer helper here.',
              createdAt: '2026-07-26T00:01:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };

    const message = composeFileCommentSubmitMessage(document);
    expect(message).toContain('File comment thread `thread-1`');
    expect(message).toContain('/workspace/src/file.ts:4-5');
    expect(message).toContain('const value = one;');
    expect(message).toContain('Use the safer helper here.');
    expect(message).not.toContain('Please inspect this.');
  });

  it('ignores resolved threads and threads without staged drafts', () => {
    const document: FileAnnotationDocument = {
      filePath: '/workspace/file.ts',
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'resolved',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/file.ts',
            quote: '',
            unanchored: true,
          },
          comments: [
            {
              id: 'user-1',
              author: 'user',
              body: 'Old draft',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    expect(composeFileCommentSubmitMessage(document)).toBe('');
  });

  it('returns submitted ids only for drafts included in the message', () => {
    const document: FileAnnotationDocument = {
      filePath: '/workspace/file.ts',
      annotations: [],
      commentThreads: [
        {
          id: 'open-thread',
          status: 'open',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/file.ts',
            quote: '',
            unanchored: true,
          },
          comments: [
            {
              id: 'included-draft',
              author: 'user',
              body: 'Send this.',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: true,
            },
          ],
        },
        {
          id: 'resolved-thread',
          status: 'resolved',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/file.ts',
            quote: '',
            unanchored: true,
          },
          comments: [
            {
              id: 'excluded-draft',
              author: 'user',
              body: 'Keep this staged.',
              createdAt: '2026-07-26T00:01:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };

    const payload = prepareFileCommentSubmit(document);

    expect(payload.message).toContain('Send this.');
    expect(payload.message).not.toContain('Keep this staged.');
    expect([...payload.submittedComments]).toEqual([
      ['included-draft', 'Send this.'],
    ]);
  });
});

describe('markFileCommentsSubmitted', () => {
  it('preserves comments added while dispatch is pending', () => {
    const document: FileAnnotationDocument = {
      filePath: '/workspace/file.ts',
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/file.ts',
            quote: '',
            unanchored: true,
          },
          comments: [
            {
              id: 'submitted-comment',
              author: 'user',
              body: 'Sent before dispatch.',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: true,
            },
            {
              id: 'concurrent-comment',
              author: 'user',
              body: 'Added while dispatch was pending.',
              createdAt: '2026-07-26T00:01:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };

    expect(
      markFileCommentsSubmitted(
        document,
        new Map([['submitted-comment', 'Sent before dispatch.']]),
      ).commentThreads[0]?.comments,
    ).toEqual([
      expect.objectContaining({ id: 'submitted-comment', staged: false }),
      expect.objectContaining({ id: 'concurrent-comment', staged: true }),
    ]);
  });

  it('keeps a submitted comment staged when its body changed during dispatch', () => {
    const document: FileAnnotationDocument = {
      filePath: '/workspace/file.ts',
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath: '/workspace/file.ts',
            quote: '',
            unanchored: true,
          },
          comments: [
            {
              id: 'submitted-comment',
              author: 'user',
              body: 'Edited during dispatch.',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };

    expect(
      markFileCommentsSubmitted(
        document,
        new Map([['submitted-comment', 'Original body.']]),
      ).commentThreads[0]?.comments[0],
    ).toMatchObject({
      body: 'Edited during dispatch.',
      staged: true,
    });
  });
});

describe('useFileComments submission', () => {
  const fixtureDocument: FileAnnotationDocument = {
    filePath: '/workspace/file.ts',
    annotations: [],
    commentThreads: [
      {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-07-26T00:00:00.000Z',
        anchorState: 'matched',
        anchor: {
          source: 'code',
          filePath: '/workspace/file.ts',
          quote: '',
          unanchored: true,
        },
        comments: [
          {
            id: 'comment-1',
            author: 'user',
            body: 'Original body.',
            createdAt: '2026-07-26T00:00:00.000Z',
            staged: true,
          },
        ],
      },
    ],
  };

  it('blocks duplicate sends and preserves an edit made while dispatch is pending', async () => {
    const save = jest
      .fn()
      .mockImplementation((request: { document: FileAnnotationDocument }) =>
        Promise.resolve(request.document),
      );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fileAnnotations: {
          get: jest.fn().mockResolvedValue(fixtureDocument),
          save,
          dismiss: jest.fn(),
          onUpdated: jest.fn().mockReturnValue(jest.fn()),
        },
      },
    });

    let comments: ReturnType<typeof useFileComments> | undefined;
    function Harness(): null {
      const current = useFileComments(
        'project-1',
        'worktree-1',
        fixtureDocument.filePath,
      );
      useEffect(() => {
        comments = current;
      }, [current]);
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });

    let acceptDispatch: ((accepted: boolean) => void) | undefined;
    const send = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acceptDispatch = resolve;
        }),
    );
    let firstSubmit: Promise<void> | undefined;
    await act(async () => {
      firstSubmit = comments?.submit(send);
      await comments?.submit(send);
    });
    expect(send).toHaveBeenCalledTimes(1);

    act(() => {
      comments?.editStagedComment('thread-1', 'comment-1', 'Edited body.');
    });
    await act(async () => {
      acceptDispatch?.(true);
      await firstSubmit;
    });

    expect(comments?.document.commentThreads[0]?.comments[0]).toMatchObject({
      body: 'Edited body.',
      staged: true,
    });
    act(() => root.unmount());
  });

  it('does not persist comparison-relative outdated state after submission', async () => {
    const baseThread = fixtureDocument.commentThreads[0];
    if (!baseThread) throw new Error('Expected the fixture comment thread.');
    const currentDiff = {
      source: 'uncommitted' as const,
      snapshotId: 'current-snapshot',
    };
    const sourceDocument: FileAnnotationDocument = {
      filePath: fixtureDocument.filePath,
      annotations: [],
      commentThreads: [
        {
          ...baseThread,
          anchor: {
            source: 'code',
            view: 'diff',
            filePath: fixtureDocument.filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'Current comparison',
            diff: currentDiff,
          },
        },
        {
          id: 'retained-thread',
          status: 'open',
          createdAt: '2026-07-26T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            view: 'diff',
            filePath: fixtureDocument.filePath,
            side: 'new',
            lineStart: 2,
            lineEnd: 2,
            quote: 'Retained comparison',
            diff: {
              source: 'committed',
              snapshotId: 'retained-snapshot',
            },
          },
          comments: [
            {
              id: 'retained-comment',
              author: 'user',
              body: 'Keep this active.',
              createdAt: '2026-07-26T00:00:00.000Z',
              staged: false,
            },
          ],
        },
      ],
    };
    const save = jest
      .fn<
        Promise<FileAnnotationDocument>,
        [{ document: FileAnnotationDocument }]
      >()
      .mockImplementation((request: { document: FileAnnotationDocument }) =>
        Promise.resolve(request.document),
      );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fileAnnotations: {
          get: jest.fn().mockResolvedValue(sourceDocument),
          save,
          dismiss: jest.fn(),
          onUpdated: jest.fn().mockReturnValue(jest.fn()),
        },
      },
    });

    let comments: ReturnType<typeof useFileComments> | undefined;
    function Harness(): null {
      const current = useFileComments(
        'project-1',
        'worktree-1',
        sourceDocument.filePath,
        'diff',
        currentDiff,
      );
      useEffect(() => {
        comments = current;
      }, [current]);
      return null;
    }

    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    await act(async () => {
      await comments?.submit(() => Promise.resolve(true));
    });

    const saved = save.mock.calls.at(-1)?.[0].document;
    expect(
      saved?.commentThreads.find((thread) => thread.id === 'retained-thread')
        ?.anchorState,
    ).toBe('matched');
    act(() => root.unmount());
  });

  it('falls back to a file anchor when a diff comment is added before its snapshot loads', async () => {
    const empty: FileAnnotationDocument = {
      filePath: fixtureDocument.filePath,
      annotations: [],
      commentThreads: [],
    };
    const save = jest.fn((request: { document: FileAnnotationDocument }) =>
      Promise.resolve(request.document),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fileAnnotations: {
          get: jest.fn().mockResolvedValue(empty),
          save,
          dismiss: jest.fn(),
          onUpdated: jest.fn().mockReturnValue(jest.fn()),
        },
      },
    });
    let current: ReturnType<typeof useFileComments> | undefined;
    function Harness(): null {
      current = useFileComments('project', 'worktree', empty.filePath, 'diff');
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    act(() => {
      current?.addComment(
        {
          source: 'code',
          filePath: empty.filePath,
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          quote: 'const value = 1;',
        },
        'Keep this comment.',
      );
    });

    expect(
      save.mock.calls.at(-1)?.[0].document.commentThreads[0]?.anchor,
    ).toEqual(expect.objectContaining({ view: 'file' }));
    expect(
      save.mock.calls.at(-1)?.[0].document.commentThreads[0]?.anchor.diff,
    ).toBeUndefined();
    act(() => root.unmount());
  });

  it('submits a refreshed diff draft with its effective outdated status', async () => {
    const raw = fixtureDocument.commentThreads[0];
    const mixed: FileAnnotationDocument = {
      ...fixtureDocument,
      commentThreads: [
        {
          ...raw,
          id: 'stale-diff-thread',
          anchor: {
            ...raw.anchor,
            view: 'diff',
            diff: { source: 'uncommitted', snapshotId: 'old-snapshot' },
          },
        },
      ],
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fileAnnotations: {
          get: jest.fn().mockResolvedValue(mixed),
          save: jest
            .fn()
            .mockImplementation(
              (request: { document: FileAnnotationDocument }) =>
                Promise.resolve(request.document),
            ),
          dismiss: jest.fn(),
          onUpdated: jest.fn().mockReturnValue(jest.fn()),
        },
      },
    });
    let current: ReturnType<typeof useFileComments> | undefined;
    function Harness(): null {
      current = useFileComments('project', 'worktree', mixed.filePath, 'diff', {
        source: 'uncommitted',
        snapshotId: 'new-snapshot',
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    const send = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
    await act(async () => {
      await current?.submit(send);
    });

    expect(send.mock.calls[0]?.[0]).toContain('anchor outdated');
    act(() => root.unmount());
  });
  it('keeps view-specific markers while the drawer and submission include both origins', async () => {
    const raw = fixtureDocument.commentThreads[0];
    const mixed: FileAnnotationDocument = {
      ...fixtureDocument,
      commentThreads: [
        raw,
        {
          ...raw,
          id: 'diff-thread',
          anchor: {
            ...raw.anchor,
            view: 'diff',
            side: 'old',
            diff: { source: 'uncommitted', snapshotId: 'snapshot' },
          },
          comments: [
            { ...raw.comments[0], id: 'diff-comment', body: 'Diff draft' },
          ],
        },
      ],
    };
    const save = jest.fn((request: { document: FileAnnotationDocument }) =>
      Promise.resolve(request.document),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fileAnnotations: {
          get: jest.fn().mockResolvedValue(mixed),
          save,
          dismiss: jest.fn(),
          onUpdated: jest.fn().mockReturnValue(jest.fn()),
        },
      },
    });
    let current: ReturnType<typeof useFileComments> | undefined;
    let snapshotId = 'snapshot';
    function Harness({ view }: { view: 'file' | 'diff' }): null {
      current = useFileComments('project', 'worktree', mixed.filePath, view, {
        source: 'uncommitted',
        snapshotId,
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      await Promise.resolve();
      root.render(createElement(Harness, { view: 'diff' }));
    });
    expect(current?.document.commentThreads.map((thread) => thread.id)).toEqual(
      ['diff-thread'],
    );
    expect(current?.drawerThreads?.map((thread) => thread.id)).toEqual([
      raw.id,
      'diff-thread',
    ]);
    expect(current?.otherViewCount).toBe(1);
    const send = jest.fn((_message: string): Promise<boolean> => {
      void _message;
      return Promise.resolve(true);
    });
    await act(async () => {
      await current?.submit(send);
    });
    expect(send.mock.calls[0]?.[0]).toContain('Diff draft');
    expect(send.mock.calls[0]?.[0]).toContain('Original body.');
    const saved = save.mock.calls.at(-1)?.[0].document;
    expect(
      saved?.commentThreads.find((thread) => thread.id === raw.id)?.comments[0]
        ?.staged,
    ).toBe(false);
    expect(
      saved?.commentThreads.find((thread) => thread.id === 'diff-thread')
        ?.comments[0]?.staged,
    ).toBe(false);
    await act(async () => {
      await Promise.resolve();
      root.render(createElement(Harness, { view: 'file' }));
    });
    expect(current?.document.commentThreads.map((thread) => thread.id)).toEqual(
      [raw.id],
    );
    expect(current?.otherViewCount).toBe(1);
    snapshotId = 'new-comparison';
    act(() => root.render(createElement(Harness, { view: 'file' })));
    expect(
      current?.drawerThreads?.find((thread) => thread.id === 'diff-thread')
        ?.anchorState,
    ).toBe('outdated');
    expect(current?.otherViewCount).toBe(0);
    act(() => root.unmount());
  });
});
