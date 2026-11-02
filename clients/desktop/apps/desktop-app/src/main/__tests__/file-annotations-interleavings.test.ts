/**
 * Concurrent callers of `core.annotation.*` (CAN-4104): a renderer window and
 * a remote-control bridge (both through `file-annotations:*` IPC) and an agent
 * comment tool, against one real state file through a real desktop
 * dispatcher. Each case acknowledges one caller's change, then lets another
 * caller write from a document that predates it, and checks the acknowledged
 * change survives.
 *
 * Current-release callers send `expectedRevision` on every save, so a stale
 * save is refused. A save without one comes only from a pre-CAN-4104 remote
 * controller and keeps the legacy merge; agent replies and appends survive
 * it, while it can still undo another window's edit or dismissal (recorded
 * compatibility debt, see the CAN-4104 behavior inventory).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PathsModule from '../lib/paths';
import type * as FileBrowserRootsModule from '../lib/file-browser-roots';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileAnnotationDocument,
  type ReviewAnnotation,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotations-interleave-'));

jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => join(tempDir, `${projectId}-${worktreeId}.json`),
}));
jest.mock('../lib/file-browser-roots', () => ({
  ...jest.requireActual<typeof FileBrowserRootsModule>(
    '../lib/file-browser-roots',
  ),
  getFileBrowserRoots:
    (): Promise<FileBrowserRootsModule.FileBrowserRootsResult> =>
      Promise.resolve({
        roots: [
          {
            repoId: 'repo',
            repoName: 'repo',
            absolutePath: '/workspace',
            rootKind: 'git-repo',
            gitAware: true,
            excludedDescendantRoots: [],
          },
        ],
        rootMap: new Map(),
      }),
}));

import { registerIpcHandler } from '../ipc/register';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { respondToFileComment } from '../canopy-tools/file-comment-core-client';

const FILE = '/workspace/src/a.ts';

const callers: Record<'renderer' | 'bridge', CanopyCallerDescriptor> = {
  renderer: {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'desktop-local',
    interfaceKind: 'desktop',
    grants: [],
  },
  bridge: {
    principalId: 'remote-device:controller-1',
    clientInstanceId: 'remote-bridge:9',
    authorityId: 'desktop-local',
    interfaceKind: 'desktop',
    grants: [],
  },
};

const annotation: ReviewAnnotation = {
  id: 'ann-1',
  repoId: 'repo',
  filePath: FILE,
  side: 'new',
  lineStart: 1,
  lineEnd: 1,
  kind: 'context',
  title: 'Title',
  body: 'Body',
};

const userThread = (
  overrides: Partial<ReviewCommentThread> = {},
): ReviewCommentThread => ({
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    filePath: FILE,
    quote: 'one',
    lineStart: 1,
    annotationId: 'ann-1',
  },
  comments: [
    {
      id: 'c-1',
      author: 'user',
      body: 'Please check.',
      createdAt: '2026-10-01T00:00:00.000Z',
      staged: false,
    },
  ],
  ...overrides,
});

const dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
registerFileAnnotationsHandlers(
  () => [null],
  dispatcher,
  (event) => (event.sender.id === 9 ? callers.bridge : callers.renderer),
);

function ipc(
  who: 'renderer' | 'bridge',
  channel: string,
  request: unknown,
): Promise<FileAnnotationDocument> {
  const registered = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  const handler: unknown = registered?.[1];
  if (typeof handler !== 'function') throw new Error(`No ${channel} handler`);
  return Promise.resolve(
    Reflect.apply(handler, undefined, [
      { sender: { id: who === 'bridge' ? 9 : 1 } },
      request,
    ]),
  );
}

let scopeIndex = 0;
/** A fresh worktree whose document holds the annotation and one thread. */
async function seed(): Promise<{
  scope: { projectId: string; worktreeId: string };
  base: FileAnnotationDocument;
}> {
  scopeIndex += 1;
  const scope = { projectId: 'project', worktreeId: `worktree-${scopeIndex}` };
  const base = await ipc('renderer', IPC_CHANNELS.fileAnnotationsAppend, {
    ...scope,
    filePath: FILE,
    annotations: [annotation],
    commentThreads: [userThread()],
  });
  return { scope, base };
}

/** Saves an edit of `from`, as the renderer does: its threads are the base. */
function save(
  who: 'renderer' | 'bridge',
  scope: { projectId: string; worktreeId: string },
  from: FileAnnotationDocument,
  edit: (document: FileAnnotationDocument) => FileAnnotationDocument,
  withRevision = true,
): Promise<FileAnnotationDocument> {
  return ipc(who, IPC_CHANNELS.fileAnnotationsSave, {
    ...scope,
    document: edit(from),
    baseCommentThreadIds: from.commentThreads.map((thread) => thread.id),
    ...(withRevision ? { expectedRevision: from.revision } : {}),
  });
}

const revisionOf = (document: FileAnnotationDocument): number =>
  document.revision ?? 0;

function read(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<FileAnnotationDocument> {
  return ipc('renderer', IPC_CHANNELS.fileAnnotationsGet, {
    ...scope,
    filePath: FILE,
  });
}

const withReply =
  (body: string) =>
  (document: FileAnnotationDocument): FileAnnotationDocument => ({
    ...document,
    commentThreads: document.commentThreads.map((thread) => ({
      ...thread,
      comments: [
        ...thread.comments,
        {
          id: `reply-${body}`,
          author: 'user',
          body,
          createdAt: '2026-10-02T00:00:00.000Z',
          staged: false,
        },
      ],
    })),
  });

const resolved = (
  document: FileAnnotationDocument,
): FileAnnotationDocument => ({
  ...document,
  commentThreads: document.commentThreads.map((thread) => ({
    ...thread,
    status: 'resolved',
  })),
});

afterAll(async () => {
  await dispatcher.shutdown();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('concurrent file annotation callers', () => {
  describe.each([
    ['renderer', 'bridge'],
    ['bridge', 'renderer'],
  ] as const)('%s acknowledged, then a stale %s save', (first, second) => {
    it('keeps an acknowledged reply', async () => {
      const { scope, base } = await seed();
      const acknowledged = await save(first, scope, base, withReply('Mine'));
      expect(acknowledged.revision).toBe(revisionOf(base) + 1);
      await expect(save(second, scope, base, resolved)).rejects.toThrow(
        'The file annotations changed.',
      );
      await expect(read(scope)).resolves.toEqual(acknowledged);
    });

    it('keeps an acknowledged resolution and thread deletion', async () => {
      const { scope, base } = await seed();
      const acknowledged = await save(first, scope, base, resolved);
      await expect(
        save(second, scope, base, withReply('Late')),
      ).rejects.toThrow('The file annotations changed.');
      const deleted = await save(first, scope, acknowledged, (document) => ({
        ...document,
        commentThreads: [],
      }));
      expect(deleted.commentThreads).toEqual([]);
      await expect(
        save(second, scope, acknowledged, withReply('Late')),
      ).rejects.toThrow('The file annotations changed.');
      await expect(read(scope)).resolves.toEqual(deleted);
    });

    it('keeps an acknowledged dismissal', async () => {
      const { scope, base } = await seed();
      const dismissed = await ipc(first, IPC_CHANNELS.fileAnnotationsDismiss, {
        ...scope,
        filePath: FILE,
        annotationId: annotation.id,
      });
      expect(dismissed.annotations).toEqual([]);
      await expect(
        save(second, scope, base, withReply('Late')),
      ).rejects.toThrow('The file annotations changed.');
      await expect(read(scope)).resolves.toEqual(dismissed);
    });
  });

  describe.each([true, false])(
    'agent work against a stale save (expected revision sent: %s)',
    (withRevision) => {
      it('keeps an acknowledged agent reply and resolution', async () => {
        const { scope, base } = await seed();
        const reply = await respondToFileComment(
          {
            ...scope,
            threadId: 'thread-1',
            body: 'Fixed.',
            resolve: true,
          },
          dispatcher,
        );
        expect(reply).toMatchObject({ ok: true, resolved: true });
        const stale = save(
          'renderer',
          scope,
          base,
          withReply('Stale'),
          withRevision,
        );
        if (withRevision) await expect(stale).rejects.toThrow();
        else await stale;
        const current = await read(scope);
        expect(current.commentThreads[0]?.status).toBe('resolved');
        expect(
          current.commentThreads[0]?.comments.filter(
            (comment) => comment.author === 'agent',
          ),
        ).toEqual([expect.objectContaining({ body: 'Fixed.' })]);
      });

      it('keeps an acknowledged append', async () => {
        const { scope, base } = await seed();
        const appendedThread = userThread({
          id: 'thread-2',
          anchor: {
            source: 'code',
            filePath: FILE,
            quote: 'two',
            lineStart: 2,
          },
        });
        await ipc('bridge', IPC_CHANNELS.fileAnnotationsAppend, {
          ...scope,
          filePath: FILE,
          annotations: [{ ...annotation, id: 'ann-2' }],
          commentThreads: [appendedThread],
        });
        const stale = save('renderer', scope, base, resolved, withRevision);
        if (withRevision) await expect(stale).rejects.toThrow();
        else await stale;
        const current = await read(scope);
        expect(current.annotations.map((entry) => entry.id)).toEqual([
          'ann-1',
          'ann-2',
        ]);
        expect(current.commentThreads.map((entry) => entry.id)).toContain(
          'thread-2',
        );
      });
    },
  );

  it('serializes simultaneous writers without losing any of them', async () => {
    const { scope, base } = await seed();
    const results = await Promise.allSettled([
      save('renderer', scope, base, withReply('Renderer')),
      save('bridge', scope, base, withReply('Bridge')),
      respondToFileComment(
        { ...scope, threadId: 'thread-1', body: 'Agent', resolve: false },
        dispatcher,
      ),
      ipc('bridge', IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope,
        filePath: FILE,
        annotations: [{ ...annotation, id: 'ann-3' }],
        commentThreads: [],
      }),
    ]);
    // Exactly one of the two saves from the same base wins.
    expect(results.slice(0, 2).map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      results.slice(2).every((result) => result.status === 'fulfilled'),
    ).toBe(true);
    const current = await read(scope);
    expect(current.revision).toBe(revisionOf(base) + 3);
    expect(current.annotations.map((entry) => entry.id)).toContain('ann-3');
    expect(
      current.commentThreads[0]?.comments.map((comment) => comment.body),
    ).toEqual(['Please check.', 'Renderer', 'Agent']);
  });

  it('refuses an agent reply in a read-only scope with a tool result', async () => {
    await expect(
      respondToFileComment(
        {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
          threadId: 'thread-1',
          body: 'Done.',
          resolve: true,
        },
        dispatcher,
      ),
    ).resolves.toEqual({
      ok: false,
      resolved: false,
      error: 'Shared-container recipient workspaces are read-only',
    });
  });
});
