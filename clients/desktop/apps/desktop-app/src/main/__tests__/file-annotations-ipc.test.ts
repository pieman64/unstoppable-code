jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));

const mockReadAnnotationFileRoots = jest.fn();
jest.mock('../canopy-runtime/core-annotation-adapter', () => ({
  readAnnotationFileRoots: (...args: unknown[]): unknown =>
    mockReadAnnotationFileRoots(...args),
}));

import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileAnnotationDocument,
  type ReviewAnnotation,
} from '@canopy/desktop-shared/types';
import {
  ANNOTATION_GRANTS,
  type CanopyCallerDescriptor,
  type CanonicalFileAnnotationDocument,
} from '@canopy/protocol/canopy-core';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import { registerIpcHandler } from '../ipc/register';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import { publishFileAnnotationsUpdated } from '../canopy-runtime/annotation-update-publisher';

const mockedRegister = jest.mocked(registerIpcHandler);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedSendToAllWindows = jest.mocked(sendToAllWindows);

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:7',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants: ['core.chat.read'],
};
const trustedEvent = { sender: { id: 7 } };
const resolveCaller = jest.fn(() => caller);

const ROOT = { id: 'repo', absolutePath: '/workspace' };
const FILE = '/workspace/src/file.ts';
const FILE_REF = { kind: 'root', rootId: 'repo', path: 'src/file.ts' } as const;

const annotation: ReviewAnnotation = {
  id: 'annotation-1',
  repoId: 'repo',
  filePath: FILE,
  side: 'new',
  lineStart: 1,
  lineEnd: 1,
  kind: 'context',
  title: 'Title',
  body: 'Body',
};

const canonical: CanonicalFileAnnotationDocument = {
  file: FILE_REF,
  revision: 4,
  annotations: [
    {
      ...annotation,
      filePath: { kind: 'root', rootId: 'repo', path: 'src/file.ts' },
    },
  ],
  commentThreads: [],
};

const legacy: FileAnnotationDocument = {
  filePath: FILE,
  revision: 4,
  annotations: [annotation],
  commentThreads: [],
};

const query = jest.fn();
const instruction = jest.fn();
const dispatcher = { query, instruction };

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registered = mockedRegister.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!registered) {
    throw new Error(`Expected handler for ${channel}`);
  }
  const handler: unknown = registered[1];
  if (typeof handler !== 'function') {
    throw new Error(`Expected function handler for ${channel}`);
  }
  return (...args: unknown[]): unknown =>
    Reflect.apply(handler, undefined, args);
}

function invoke(channel: string, request: unknown): Promise<unknown> {
  return Promise.resolve(
    Reflect.apply(getHandler(channel), undefined, [trustedEvent, request]),
  );
}

describe('file annotations IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadAnnotationFileRoots.mockResolvedValue([ROOT]);
    query.mockResolvedValue({ document: canonical });
    instruction.mockResolvedValue({ document: canonical });
    registerFileAnnotationsHandlers(() => [null], dispatcher, resolveCaller);
  });

  it('registers get, save, append, and dismiss handlers', () => {
    expect(mockedRegister.mock.calls.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.fileAnnotationsGet,
      IPC_CHANNELS.fileAnnotationsSave,
      IPC_CHANNELS.fileAnnotationsAppend,
      IPC_CHANNELS.fileAnnotationsDismiss,
    ]);
  });

  it('reads through core.annotation.document.get with only the read grant, without broadcasting', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsGet, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: '/workspace/src/./file.ts',
      }),
    ).resolves.toEqual(legacy);
    expect(resolveCaller).toHaveBeenCalledWith(trustedEvent);
    expect(query).toHaveBeenCalledWith(
      'core.annotation.document.get',
      {
        scope: { projectId: 'project', worktreeId: 'worktree' },
        file: FILE_REF,
      },
      { caller: { ...caller, grants: [ANNOTATION_GRANTS.read] } },
    );
    expect(instruction).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('saves with host paths projected, the write grant and the expected revision', async () => {
    // The core.annotation adapter publishes from inside the dispatcher call;
    // the projection's windows are the ones it reaches.
    instruction.mockImplementationOnce(
      async (
        _name: string,
        params: { scope: { projectId: string; worktreeId: string } },
      ) => {
        await publishFileAnnotationsUpdated(params.scope, canonical);
        return { document: canonical };
      },
    );
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsSave, {
        projectId: 'project',
        worktreeId: 'worktree',
        document: { ...legacy, revision: 3 },
        baseCommentThreadIds: ['thread-1', 7],
        expectedRevision: 3,
      }),
    ).resolves.toEqual(legacy);
    expect(instruction).toHaveBeenCalledWith(
      'core.annotation.document.save',
      {
        scope: { projectId: 'project', worktreeId: 'worktree' },
        document: {
          file: FILE_REF,
          annotations: canonical.annotations,
          commentThreads: [],
        },
        baseCommentThreadIds: ['thread-1'],
        expectedRevision: 3,
      },
      { caller: { ...caller, grants: [ANNOTATION_GRANTS.write] } },
    );
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.fileAnnotationsUpdated,
      { projectId: 'project', worktreeId: 'worktree', document: legacy },
    );
    expect(mockedSendToAllWindows).not.toHaveBeenCalled();
  });

  it('omits the expected revision when the renderer sends none', async () => {
    await invoke(IPC_CHANNELS.fileAnnotationsSave, {
      projectId: 'project',
      worktreeId: 'worktree',
      document: { filePath: FILE, annotations: [], commentThreads: [] },
    });
    expect(instruction).toHaveBeenCalledWith(
      'core.annotation.document.save',
      {
        scope: { projectId: 'project', worktreeId: 'worktree' },
        document: { file: FILE_REF, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      },
      expect.anything(),
    );
  });

  it.each([-1, 1.5, '3', Number.NaN])(
    'refuses a malformed expected revision %p before dispatch',
    async (expectedRevision) => {
      await expect(
        invoke(IPC_CHANNELS.fileAnnotationsSave, {
          projectId: 'project',
          worktreeId: 'worktree',
          document: legacy,
          baseCommentThreadIds: [],
          expectedRevision,
        }),
      ).rejects.toThrow('Invalid expectedRevision');
      expect(instruction).not.toHaveBeenCalled();
    },
  );

  it('appends and dismisses through their operations without publishing themselves', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsAppend, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: FILE,
        annotations: [annotation, { id: 'not-an-annotation' }],
        commentThreads: 'not an array',
      }),
    ).resolves.toEqual(legacy);
    expect(instruction).toHaveBeenLastCalledWith(
      'core.annotation.document.append',
      {
        scope: { projectId: 'project', worktreeId: 'worktree' },
        file: FILE_REF,
        annotations: canonical.annotations,
        commentThreads: [],
      },
      { caller: { ...caller, grants: [ANNOTATION_GRANTS.write] } },
    );

    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsDismiss, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: FILE,
        annotationId: 'annotation-1',
      }),
    ).resolves.toEqual(legacy);
    expect(instruction).toHaveBeenLastCalledWith(
      'core.annotation.document.dismiss',
      {
        scope: { projectId: 'project', worktreeId: 'worktree' },
        file: FILE_REF,
        annotationId: 'annotation-1',
      },
      { caller: { ...caller, grants: [ANNOTATION_GRANTS.write] } },
    );
    // Publication belongs to the adapter behind the dispatcher, not here.
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedSendToAllWindows).not.toHaveBeenCalled();
  });

  it('sends a file outside every root as a host handle and maps it back', async () => {
    mockReadAnnotationFileRoots.mockResolvedValue([]);
    let handle: unknown;
    query.mockImplementation((_name: string, params: { file: unknown }) => {
      handle = params.file;
      return Promise.resolve({
        document: {
          ...canonical,
          file: params.file,
          annotations: [],
        },
      });
    });
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsGet, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: '/tmp/outside.md',
      }),
    ).resolves.toEqual({
      filePath: '/tmp/outside.md',
      revision: 4,
      annotations: [],
      commentThreads: [],
    });
    expect(handle).toMatchObject({ kind: 'host' });
    expect(JSON.stringify(handle)).not.toContain('/tmp');
  });

  it('rejects invalid scope ids before dispatch', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsAppend, {
        projectId: 'INVALID',
        worktreeId: 'worktree',
        filePath: FILE,
        annotations: [],
        commentThreads: [],
      }),
    ).rejects.toThrow('Invalid projectId');
    expect(instruction).not.toHaveBeenCalled();
  });

  it.each([
    IPC_CHANNELS.fileAnnotationsSave,
    IPC_CHANNELS.fileAnnotationsAppend,
    IPC_CHANNELS.fileAnnotationsDismiss,
  ])('rejects recipient mutations through %s', async (channel) => {
    const request = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      filePath: FILE,
      annotationId: 'annotation-1',
      document: legacy,
      baseCommentThreadIds: [],
      annotations: [],
      commentThreads: [],
    };

    await expect(invoke(channel, request)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    expect(instruction).not.toHaveBeenCalled();
  });

  it('rejects an invalid annotation id before dismissing', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsDismiss, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: FILE,
        annotationId: '../annotation',
      }),
    ).rejects.toThrow('Invalid annotationId');
    expect(instruction).not.toHaveBeenCalled();
  });

  it('refuses an untrusted sender before any read or write', async () => {
    resolveCaller.mockImplementationOnce(() => {
      throw canopyPermissionDeniedError('Untrusted desktop IPC sender.');
    });
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsSave, {
        projectId: 'project',
        worktreeId: 'worktree',
        document: legacy,
        baseCommentThreadIds: [],
      }),
    ).rejects.toThrow('Untrusted desktop IPC sender.');
    expect(instruction).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('does not publish a refused write', async () => {
    instruction.mockRejectedValueOnce(new Error('conflict'));
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsSave, {
        projectId: 'project',
        worktreeId: 'worktree',
        document: legacy,
        baseCommentThreadIds: [],
        expectedRevision: 1,
      }),
    ).rejects.toThrow('conflict');
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
});
