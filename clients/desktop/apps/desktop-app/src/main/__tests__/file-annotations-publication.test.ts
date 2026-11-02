/**
 * CAN-4104: `file-annotations:updated` is published by the core.annotation
 * adapter, once per committed write, for every binding that reaches the
 * desktop dispatcher: the IPC projection, the agent comment tools and the
 * renderer relay. Each event is checked against the state file at the moment
 * it is sent, so it can only follow the completed write.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PathsModule from '../lib/paths';
import type * as FileBrowserRootsModule from '../lib/file-browser-roots';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayReply } from '../../shared/canopy-core-relay';
import { isRecord } from '../lib/type-guards';

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotations-publication-'));
const statePath = (projectId: string, worktreeId: string): string =>
  join(tempDir, `${projectId}-${worktreeId}.json`);

interface Sent {
  target: string;
  channel: string;
  payload: unknown;
  /** The state file as it was when the event was sent. */
  stateAtSend: unknown;
}

const mockSent: Sent[] = [];

function mockStateAtSend(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  const { projectId, worktreeId } = payload;
  if (typeof projectId !== 'string' || typeof worktreeId !== 'string')
    return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(statePath(projectId, worktreeId), 'utf8'),
    );
    return parsed;
  } catch {
    return null;
  }
}

jest.mock('../lib/window-send', () => ({
  sendToWindow: (window: unknown, channel: string, payload: unknown): void => {
    mockSent.push({
      target: String(window),
      channel,
      payload,
      stateAtSend: mockStateAtSend(payload),
    });
  },
  sendToAllWindows: (channel: string, payload: unknown): void => {
    mockSent.push({
      target: 'all-windows',
      channel,
      payload,
      stateAtSend: mockStateAtSend(payload),
    });
  },
}));

jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => statePath(projectId, worktreeId),
}));

jest.mock('../lib/file-browser-roots', () => ({
  ...jest.requireActual<typeof FileBrowserRootsModule>(
    '../lib/file-browser-roots',
  ),
  getFileBrowserRoots:
    (): Promise<FileBrowserRootsModule.FileBrowserRootsResult> => {
      const root: FileBrowserRootsModule.FileBrowserRoot = {
        repoId: 'repo',
        repoName: 'repo',
        absolutePath: '/workspace',
        rootKind: 'git-repo',
        gitAware: true,
        excludedDescendantRoots: [],
      };
      return Promise.resolve({
        roots: [root],
        rootMap: new Map([['repo', root]]),
      });
    },
}));

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { registerIpcHandler } from '../ipc/register';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import { respondToFileComment } from '../canopy-tools/file-comment-core-client';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelay,
} from '../canopy-runtime/renderer-relay/relay';

const FILE = '/workspace/src/a.ts';
const FILE_REF = { kind: 'root', rootId: 'repo', path: 'src/a.ts' } as const;
const SCOPE = { projectId: 'p1', worktreeId: 'w1' };

const thread: ReviewCommentThread = {
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    repoId: 'repo',
    filePath: FILE,
    side: 'new',
    lineStart: 1,
    lineEnd: 1,
    quote: 'one',
  },
  comments: [
    {
      id: 'comment-1',
      author: 'user',
      body: 'Please look.',
      createdAt: '2026-10-01T00:00:00.000Z',
      staged: false,
    },
  ],
};

class FakeSender extends EventEmitter {
  readonly mainFrame = {
    url: 'app://renderer/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return this.mainFrame.url;
  }
  isDestroyed(): boolean {
    return false;
  }
}

const RELAY_TRUSTED_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:9',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants: ['core.annotation.read', 'core.annotation.write'],
};

let runtime: DesktopCanopyDispatcher;
let relay: RendererRelay;
const sender = new FakeSender(9);

function relayCall(
  method: string,
  params: Record<string, unknown>,
): Promise<CanopyCoreRelayReply> {
  return relay.invoke(
    { sender, senderFrame: sender.mainFrame },
    { kind: 'request', method, params },
  );
}

function ipc(channel: string, request: unknown): Promise<unknown> {
  const registered = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!registered) throw new Error(`No handler for ${channel}`);
  const handler: unknown = registered[1];
  if (typeof handler !== 'function') throw new Error('Not a handler');
  return Promise.resolve(
    Reflect.apply(handler, undefined, [{ sender: {} }, request]),
  );
}

function revisionOf(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const document = value.document;
  return isRecord(document) ? document.revision : undefined;
}

/** The stored document for FILE when the event was sent. */
function storedRevision(sent: Sent): unknown {
  if (!isRecord(sent.stateAtSend)) return undefined;
  const files = sent.stateAtSend.files;
  if (!Array.isArray(files)) return undefined;
  const entry: unknown = files.find(
    (file) => isRecord(file) && file.filePath === FILE,
  );
  return isRecord(entry) ? entry.revision : undefined;
}

async function seed(): Promise<number> {
  const before = mockSent.length;
  const document = await ipc(IPC_CHANNELS.fileAnnotationsAppend, {
    ...SCOPE,
    filePath: FILE,
    annotations: [],
    commentThreads: [thread],
  });
  mockSent.splice(before);
  const revision = isRecord(document) ? document.revision : undefined;
  if (typeof revision !== 'number') throw new Error('No seeded revision.');
  return revision;
}

beforeEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  jest.mocked(registerIpcHandler).mockClear();
  mockSent.length = 0;
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  registerFileAnnotationsHandlers(
    () => ['main-window' as never, 'advisor-window' as never],
    runtime,
    () => ({
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-web-contents:1',
      authorityId: 'desktop-local',
      interfaceKind: 'desktop',
      grants: [],
    }),
  );
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: () => ({ surface: 'main', caller: RELAY_TRUSTED_CALLER }),
  });
});

afterEach(async () => {
  relay.dispose();
  await runtime.shutdown();
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('file-annotations:updated publication', () => {
  it('publishes a relay write once to every window, after the state file holds it', async () => {
    const revision = await seed();
    const reply = await relayCall('core.annotation.document.save', {
      scope: SCOPE,
      document: { file: FILE_REF, annotations: [], commentThreads: [] },
      baseCommentThreadIds: [],
      expectedRevision: revision,
    });
    expect(reply).toMatchObject({ ok: true });
    expect(mockSent).toHaveLength(1);
    const [sent] = mockSent;
    expect(sent).toMatchObject({
      target: 'all-windows',
      channel: IPC_CHANNELS.fileAnnotationsUpdated,
      payload: {
        ...SCOPE,
        document: { filePath: FILE, revision: revision + 1 },
      },
    });
    // The event carries host paths, never the portable file reference.
    expect(JSON.stringify(sent.payload)).not.toContain('"rootId"');
    expect(storedRevision(sent)).toBe(revisionOf(sent.payload));
  });

  it('publishes a relay reply and append the same way', async () => {
    await seed();
    await expect(
      relayCall('core.annotation.thread.reply', {
        scope: SCOPE,
        threadId: thread.id,
        body: 'Done.',
        resolve: false,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      relayCall('core.annotation.document.append', {
        scope: SCOPE,
        file: FILE_REF,
        annotations: [],
        commentThreads: [],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      relayCall('core.annotation.document.dismiss', {
        scope: SCOPE,
        file: FILE_REF,
        annotationId: 'missing',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockSent.map((sent) => sent.target)).toEqual([
      'all-windows',
      'all-windows',
      'all-windows',
    ]);
    for (const sent of mockSent)
      expect(storedRevision(sent)).toBe(revisionOf(sent.payload));
  });

  it('publishes nothing for a relay write refused by a revision conflict', async () => {
    const revision = await seed();
    const reply = await relayCall('core.annotation.document.save', {
      scope: SCOPE,
      document: { file: FILE_REF, annotations: [], commentThreads: [] },
      baseCommentThreadIds: [thread.id],
      expectedRevision: revision - 1,
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'conflict', code: 'core.annotation.revisionConflict' },
    });
    expect(mockSent).toEqual([]);
  });

  it.each([
    [
      'core.annotation.document.save',
      {
        document: { file: FILE_REF, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      },
    ],
    [
      'core.annotation.document.append',
      { file: FILE_REF, annotations: [], commentThreads: [] },
    ],
    [
      'core.annotation.document.dismiss',
      { file: FILE_REF, annotationId: 'ann-1' },
    ],
    [
      'core.annotation.thread.reply',
      { threadId: thread.id, body: 'b', resolve: true },
    ],
  ])(
    'publishes nothing for a relay %s to a read-only scope',
    async (method, params) => {
      const reply = await relayCall(method, {
        scope: {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
        },
        ...params,
      });
      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'core.annotation.readOnlyScope' },
      });
      expect(mockSent).toEqual([]);
    },
  );

  it('publishes an IPC write once to each window the projection serves', async () => {
    const revision = await seed();
    await ipc(IPC_CHANNELS.fileAnnotationsSave, {
      ...SCOPE,
      document: { filePath: FILE, annotations: [], commentThreads: [thread] },
      baseCommentThreadIds: [thread.id],
      expectedRevision: revision,
    });
    expect(mockSent.map((sent) => sent.target)).toEqual([
      'main-window',
      'advisor-window',
    ]);
    for (const sent of mockSent) {
      expect(sent.payload).toMatchObject({
        ...SCOPE,
        document: { filePath: FILE, revision: revision + 1 },
      });
      expect(storedRevision(sent)).toBe(revision + 1);
    }
  });

  it('publishes nothing for an IPC write refused by a revision conflict', async () => {
    const revision = await seed();
    await expect(
      ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...SCOPE,
        document: { filePath: FILE, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [thread.id],
        expectedRevision: revision + 5,
      }),
    ).rejects.toThrow();
    expect(mockSent).toEqual([]);
  });

  it('publishes an agent reply once to every window, and nothing for a refused one', async () => {
    const revision = await seed();
    await expect(
      respondToFileComment(
        { ...SCOPE, threadId: thread.id, body: 'Fixed.', resolve: true },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: true, resolved: true });
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0]).toMatchObject({
      target: 'all-windows',
      payload: { ...SCOPE, document: { revision: revision + 1 } },
    });
    expect(storedRevision(mockSent[0])).toBe(revision + 1);

    mockSent.length = 0;
    await expect(
      respondToFileComment(
        { ...SCOPE, threadId: 'missing', body: 'Hello?', resolve: false },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      respondToFileComment(
        {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
          threadId: thread.id,
          body: 'Hello?',
          resolve: false,
        },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(mockSent).toEqual([]);
  });

  it('publishes nothing for reads', async () => {
    await seed();
    await ipc(IPC_CHANNELS.fileAnnotationsGet, { ...SCOPE, filePath: FILE });
    await expect(
      relayCall('core.annotation.thread.list', { scope: SCOPE }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockSent).toEqual([]);
  });
});
