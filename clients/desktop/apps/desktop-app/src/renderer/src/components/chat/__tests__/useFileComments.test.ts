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

describe('useFileComments revisions (CAN-4104)', () => {
  const FILE = '/workspace/file.ts';
  const thread = (
    id: string,
    status: 'open' | 'resolved' = 'open',
  ): FileAnnotationDocument['commentThreads'][number] => ({
    id,
    status,
    createdAt: '2026-10-01T00:00:00.000Z',
    anchorState: 'matched',
    anchor: { source: 'code', filePath: FILE, quote: '', unanchored: true },
    comments: [
      {
        id: `${id}-comment`,
        author: 'user',
        body: `Body ${id}`,
        createdAt: '2026-10-01T00:00:00.000Z',
        staged: false,
      },
    ],
  });

  interface SaveRequest {
    document: FileAnnotationDocument;
    baseCommentThreadIds: string[];
    expectedRevision?: number;
  }

  interface UpdatedEvent {
    projectId: string;
    worktreeId: string;
    document: FileAnnotationDocument;
  }

  interface FakeMain {
    api: {
      get: jest.Mock<Promise<FileAnnotationDocument>, []>;
      save: jest.Mock<Promise<FileAnnotationDocument>, [SaveRequest]>;
      dismiss: jest.Mock;
      onUpdated: jest.Mock<() => void, [(event: UpdatedEvent) => void]>;
    };
    saves: SaveRequest[];
    stored(): FileAnnotationDocument;
    /** Another window or an agent tool writes; its event is not delivered yet. */
    writeElsewhere(
      update: (current: FileAnnotationDocument) => FileAnnotationDocument,
    ): FileAnnotationDocument;
    emit(document: FileAnnotationDocument): void;
    /** Holds saves until the returned release runs. */
    hold(): () => void;
  }

  const nextRevision = (
    document: FileAnnotationDocument,
  ): number | undefined =>
    document.revision === undefined ? undefined : document.revision + 1;

  /** A main process that refuses stale saves, like core.annotation.document.save. */
  function fakeMain(initial: FileAnnotationDocument): FakeMain {
    let stored = initial;
    const listeners = new Set<(event: UpdatedEvent) => void>();
    const saves: SaveRequest[] = [];
    let gate: Promise<void> = Promise.resolve();
    const emit = (document: FileAnnotationDocument): void => {
      listeners.forEach((listener) =>
        listener({ projectId: 'project', worktreeId: 'worktree', document }),
      );
    };
    const api: FakeMain['api'] = {
      get: jest.fn(() => Promise.resolve(stored)),
      save: jest.fn(async (request: SaveRequest) => {
        saves.push(request);
        await gate;
        if (
          request.expectedRevision !== undefined &&
          request.expectedRevision !== stored.revision
        ) {
          throw new Error('The file annotations changed.');
        }
        stored = { ...request.document, revision: nextRevision(stored) };
        emit(stored);
        return stored;
      }),
      dismiss: jest.fn(),
      onUpdated: jest.fn((listener: (event: UpdatedEvent) => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      }),
    };
    return {
      api,
      saves,
      stored: (): FileAnnotationDocument => stored,
      writeElsewhere(update): FileAnnotationDocument {
        stored = { ...update(stored), revision: nextRevision(stored) };
        return stored;
      },
      emit,
      hold(): () => void {
        let release = (): void => undefined;
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return (): void => {
          release();
          gate = Promise.resolve();
        };
      },
    };
  }

  async function mount(main: FakeMain): Promise<{
    state: { current?: ReturnType<typeof useFileComments> };
    unmount: () => void;
  }> {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { fileAnnotations: main.api },
    });
    const state: { current?: ReturnType<typeof useFileComments> } = {};
    function Harness(): null {
      state.current = useFileComments('project', 'worktree', FILE);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    return {
      state,
      unmount: (): void => act(() => root.unmount()),
    };
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  };

  it('saves against the acknowledged revision, one save at a time', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 2,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    const release = main.hold();
    act(() => {
      view.state.current?.addReply('t1', 'First');
      view.state.current?.addReply('t1', 'Second');
    });
    expect(main.saves).toHaveLength(1);
    expect(main.saves[0]?.expectedRevision).toBe(2);
    release();
    await settle();
    expect(main.saves.map((save) => save.expectedRevision)).toEqual([2, 3]);
    expect(
      main.stored().commentThreads[0]?.comments.map((comment) => comment.body),
    ).toEqual(['Body t1', 'First', 'Second']);
    expect(main.stored().revision).toBe(4);
    view.unmount();
  });

  it('replays a refused edit on the latest document and keeps the other write', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    // An agent reply lands; its update event has not reached this window.
    main.writeElsewhere((current) => ({
      ...current,
      commentThreads: [thread('agent-thread'), ...current.commentThreads],
    }));
    act(() => {
      view.state.current?.addComment(
        { source: 'code', filePath: FILE, quote: '', unanchored: true },
        'Mine',
      );
    });
    await settle();
    expect(main.saves.map((save) => save.expectedRevision)).toEqual([1, 2]);
    expect(main.stored().commentThreads.map((entry) => entry.id)).toEqual([
      'agent-thread',
      't1',
      expect.any(String),
    ]);
    expect(main.stored().commentThreads[2]?.comments[0]?.body).toBe('Mine');
    expect(view.state.current?.document.commentThreads).toHaveLength(3);
    view.unmount();
  });

  it('applies an edit once when its own update event arrives first', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [],
    });
    const view = await mount(main);
    act(() => {
      view.state.current?.addComment(
        { source: 'code', filePath: FILE, quote: '', unanchored: true },
        'Once',
      );
    });
    await settle();
    expect(view.state.current?.document.commentThreads).toHaveLength(1);
    expect(main.stored().commentThreads).toHaveLength(1);
    view.unmount();
  });

  it('keeps the chosen status when a refused toggle is replayed', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    main.writeElsewhere((current) => ({
      ...current,
      commentThreads: current.commentThreads.map((entry) => ({
        ...entry,
        comments: [
          ...entry.comments,
          {
            id: 'agent-reply',
            author: 'agent',
            body: 'Done.',
            createdAt: '2026-10-01T00:00:00.000Z',
            staged: false,
          },
        ],
      })),
    }));
    act(() => view.state.current?.toggleResolved('t1'));
    await settle();
    expect(main.stored().commentThreads[0]).toMatchObject({
      status: 'resolved',
      comments: [{ id: 't1-comment' }, { id: 'agent-reply' }],
    });
    view.unmount();
  });

  it('ignores an update event older than the acknowledged document', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 5,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    act(() =>
      main.emit({
        filePath: FILE,
        revision: 4,
        annotations: [],
        commentThreads: [],
      }),
    );
    expect(view.state.current?.document.commentThreads).toHaveLength(1);
    view.unmount();
  });

  it('drops a retired edit’s optimistic state when its save response is older than the acknowledged document', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    const save: { finish?: (saved: FileAnnotationDocument) => void } = {};
    main.api.save.mockImplementationOnce((request: SaveRequest) => {
      main.saves.push(request);
      return new Promise<FileAnnotationDocument>((resolve) => {
        save.finish = resolve;
      });
    });
    act(() => view.state.current?.toggleResolved('t1'));
    expect(view.state.current?.document.commentThreads[0]?.status).toBe(
      'resolved',
    );
    // The resolve committed as revision 2, then another window reopened the
    // thread as revision 3; that event arrives before the save response.
    act(() =>
      main.emit({
        filePath: FILE,
        revision: 3,
        annotations: [],
        commentThreads: [thread('t1', 'open')],
      }),
    );
    await act(async () => {
      save.finish?.({
        filePath: FILE,
        revision: 2,
        annotations: [],
        commentThreads: [thread('t1', 'resolved')],
      });
      await Promise.resolve();
    });
    await settle();
    expect(main.saves).toHaveLength(1);
    expect(view.state.current?.document.commentThreads).toEqual([
      expect.objectContaining({ id: 't1', status: 'open' }),
    ]);
    view.unmount();
  });

  it('sends no expected revision to a host that reports none', async () => {
    const main = fakeMain({
      filePath: FILE,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    act(() => view.state.current?.toggleResolved('t1'));
    await settle();
    expect(main.saves).toHaveLength(1);
    expect(main.saves[0]).not.toHaveProperty('expectedRevision');
    view.unmount();
  });

  it('stops replaying after repeated refusals and keeps the edit for the next save', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    let refusals = 0;
    main.api.save.mockImplementation((request: SaveRequest) => {
      main.saves.push(request);
      refusals += 1;
      main.writeElsewhere((current) => current);
      return Promise.reject(new Error('The file annotations changed.'));
    });
    act(() => view.state.current?.toggleResolved('t1'));
    await settle();
    expect(refusals).toBe(4);
    expect(view.state.current?.document.commentThreads[0]?.status).toBe(
      'resolved',
    );
    view.unmount();
  });

  it('saves an edit queued while the previous save is finishing', async () => {
    const main = fakeMain({
      filePath: FILE,
      revision: 1,
      annotations: [],
      commentThreads: [thread('t1')],
    });
    const view = await mount(main);
    const save = main.api.save.getMockImplementation();
    if (!save) throw new Error('Missing save implementation.');
    main.api.save.mockImplementationOnce((request: SaveRequest) => {
      const result = save(request);
      // Runs after the save loop drained but before its cleanup ran.
      void result.then(() =>
        Promise.resolve().then(() =>
          view.state.current?.addReply('t1', 'Late'),
        ),
      );
      return result;
    });
    act(() => view.state.current?.addReply('t1', 'First'));
    await settle();
    expect(main.saves.map((entry) => entry.expectedRevision)).toEqual([1, 2]);
    expect(
      main.stored().commentThreads[0]?.comments.map((comment) => comment.body),
    ).toEqual(['Body t1', 'First', 'Late']);
    view.unmount();
  });
});
