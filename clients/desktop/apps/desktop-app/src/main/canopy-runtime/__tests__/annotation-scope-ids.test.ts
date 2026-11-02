import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  createCoreAnnotationAdapter,
  getDesktopAnnotationOperations,
  readAnnotationFileRoots,
} from '../core-annotation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../renderer-relay/interim-in-memory-binding';
import { createRendererRelay } from '../renderer-relay/relay';

// CAN-4104 review: scope IDs name host storage directories. The renderer relay
// skips the IPC handlers' `validateId`, so the contract must refuse unsafe IDs
// for every operation before the host resolves a state path, reads file roots
// or checks the read-only scope, and the desktop host repeats that check.

const mockStatePath = jest.fn<string, [string, string]>();
const mockFileBrowserRoots = jest.fn();
const mockIsWritableScope = jest.fn<boolean, [string]>();

jest.mock('../../lib/paths', () => ({
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => mockStatePath(projectId, worktreeId),
}));
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: (...args: unknown[]): unknown =>
    mockFileBrowserRoots(...args),
}));
jest.mock('../../lib/read-only-scope', () => ({
  isWritableScope: (projectId: string): boolean =>
    mockIsWritableScope(projectId),
}));
jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));

const UNSAFE_IDS = [
  '..',
  '.',
  '../../../x',
  'p1/../x',
  'a/b',
  'a\\b',
  '..\\..\\x',
  '%2e%2e',
  '%2e%2e%2fx',
  'a%2fb',
  '.hidden',
  '-leading',
  'Upper',
  'a b',
  'a\0b',
  `../app-workspaces/${SHARED_CONTAINER_VIEWER_PROJECT_ID}`,
];

const file = { kind: 'root', rootId: 'repo', path: 'a.ts' } as const;

const OPERATIONS = [
  ['core.annotation.document.get', { file }],
  ['core.annotation.thread.get', { threadId: 't' }],
  ['core.annotation.thread.list', {}],
  [
    'core.annotation.document.save',
    {
      document: { file, annotations: [], commentThreads: [] },
      baseCommentThreadIds: [],
    },
  ],
  [
    'core.annotation.document.append',
    { file, annotations: [], commentThreads: [] },
  ],
  ['core.annotation.document.dismiss', { file, annotationId: 'a' }],
  ['core.annotation.thread.reply', { threadId: 't', body: 'b', resolve: true }],
] as const;

let dataDir: string;
let repoDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'annotation-scope-ids-data-'));
  repoDir = mkdtempSync(join(tmpdir(), 'annotation-scope-ids-repo-'));
  mockStatePath.mockReset();
  mockStatePath.mockImplementation((projectId, worktreeId) =>
    join(dataDir, projectId, worktreeId, 'file-annotations.json'),
  );
  mockFileBrowserRoots.mockReset();
  mockFileBrowserRoots.mockResolvedValue({
    roots: [{ repoId: 'repo', absolutePath: repoDir }],
  });
  mockIsWritableScope.mockReset();
  mockIsWritableScope.mockImplementation(
    (projectId) => projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID,
  );
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function expectNoHostAccess(): void {
  expect(mockStatePath).not.toHaveBeenCalled();
  expect(mockFileBrowserRoots).not.toHaveBeenCalled();
  expect(mockIsWritableScope).not.toHaveBeenCalled();
  expect(readdirSync(dataDir)).toEqual([]);
}

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

const TRUSTED_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.annotation.read', 'core.annotation.write'],
};

describe('core.annotation scope IDs over the renderer relay', () => {
  it('refuses unsafe scope IDs for every operation before any host access', async () => {
    // The contract refuses them before a handler runs, not only the host check.
    const operations = getDesktopAnnotationOperations();
    const handlers = [
      jest.spyOn(operations, 'getDocument'),
      jest.spyOn(operations, 'getThread'),
      jest.spyOn(operations, 'listThreads'),
      jest.spyOn(operations, 'saveDocument'),
      jest.spyOn(operations, 'appendAnnotations'),
      jest.spyOn(operations, 'dismissAnnotation'),
      jest.spyOn(operations, 'replyToThread'),
    ];
    const runtime = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        publish: jest.fn(() => Promise.resolve()),
      }),
      shutdownTimeoutMs: 1_000,
    });
    const relay = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(runtime),
      resolveSurface: () => ({ surface: 'main', caller: TRUSTED_CALLER }),
    });
    const sender = new FakeSender(1);
    const call = (
      method: string,
      params: Record<string, unknown>,
    ): ReturnType<typeof relay.invoke> =>
      relay.invoke(
        { sender, senderFrame: sender.mainFrame },
        { kind: 'request', method, params },
      );
    try {
      for (const [method, rest] of OPERATIONS) {
        for (const unsafe of UNSAFE_IDS) {
          for (const scope of [
            { projectId: 'p1', worktreeId: unsafe },
            { projectId: unsafe, worktreeId: 'w1' },
          ]) {
            const reply = await call(method, { scope, ...rest });
            expect({ method, unsafe, reply }).toMatchObject({
              reply: { ok: false, error: { kind: 'invalid_argument' } },
            });
          }
        }
      }
      for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
      expectNoHostAccess();

      // The same relay path reaches storage for a valid scope.
      const saved = await call('core.annotation.document.save', {
        scope: { projectId: 'p1', worktreeId: 'w1' },
        ...OPERATIONS[3][1],
      });
      expect(saved).toMatchObject({
        ok: true,
        value: { document: { file, revision: 1 } },
      });
      expect(mockStatePath).toHaveBeenCalledWith('p1', 'w1');
      expect(mockIsWritableScope).toHaveBeenCalledWith('p1');
      expect(readdirSync(dataDir)).toEqual(['p1']);
    } finally {
      handlers.forEach((handler) => handler.mockRestore());
      relay.dispose();
      await runtime.shutdown();
    }
  });
});

describe('desktop annotation host scope validation', () => {
  // Operations called directly skip the contract; the host must still refuse.
  it.each(UNSAFE_IDS)(
    'refuses %j as a typed invalid_argument before any host access',
    async (unsafe) => {
      const operations = getDesktopAnnotationOperations();
      const invalid = { payload: { kind: 'invalid_argument' } };
      for (const scope of [
        { projectId: 'p1', worktreeId: unsafe },
        { projectId: unsafe, worktreeId: 'w1' },
      ]) {
        await expect(
          operations.getDocument({ scope, file }),
        ).rejects.toMatchObject(invalid);
        await expect(operations.listThreads({ scope })).rejects.toMatchObject(
          invalid,
        );
        await expect(
          operations.getThread({ scope, threadId: 't' }),
        ).rejects.toMatchObject(invalid);
        await expect(
          operations.saveDocument({
            scope,
            document: { file, annotations: [], commentThreads: [] },
            baseCommentThreadIds: [],
          }),
        ).rejects.toMatchObject(invalid);
        await expect(
          operations.appendAnnotations({
            scope,
            file,
            annotations: [],
            commentThreads: [],
          }),
        ).rejects.toMatchObject(invalid);
        await expect(
          operations.dismissAnnotation({ scope, file, annotationId: 'a' }),
        ).rejects.toMatchObject(invalid);
        await expect(
          operations.replyToThread({
            scope,
            threadId: 't',
            body: 'b',
            resolve: true,
          }),
        ).rejects.toMatchObject(invalid);
        await expect(readAnnotationFileRoots(scope)).rejects.toMatchObject(
          invalid,
        );
      }
      expectNoHostAccess();
    },
  );
});
