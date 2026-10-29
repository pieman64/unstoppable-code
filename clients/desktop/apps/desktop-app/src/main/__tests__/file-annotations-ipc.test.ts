jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/file-annotations-persistence', () => ({
  appendFileAnnotations: jest.fn(),
  dismissFileAnnotation: jest.fn(),
  readFileAnnotationDocument: jest.fn(),
  saveFileAnnotationDocument: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type FileAnnotationDocument,
} from '@canopy/desktop-shared/types';
import { registerFileAnnotationsHandlers } from '../ipc/file-annotations';
import { registerIpcHandler } from '../ipc/register';
import {
  appendFileAnnotations,
  dismissFileAnnotation,
  readFileAnnotationDocument,
  saveFileAnnotationDocument,
} from '../lib/file-annotations-persistence';
import { sendToWindow } from '../lib/window-send';

const mockedAppend = jest.mocked(appendFileAnnotations);
const mockedDismiss = jest.mocked(dismissFileAnnotation);
const mockedRead = jest.mocked(readFileAnnotationDocument);
const mockedRegister = jest.mocked(registerIpcHandler);
const mockedSave = jest.mocked(saveFileAnnotationDocument);
const mockedSendToWindow = jest.mocked(sendToWindow);

const document: FileAnnotationDocument = {
  filePath: '/workspace/file.ts',
  annotations: [],
  commentThreads: [],
};

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
  return handler;
}

function invoke(channel: string, request: unknown): Promise<unknown> {
  return Promise.resolve(
    Reflect.apply(getHandler(channel), undefined, [undefined, request]),
  );
}

describe('file annotations IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerFileAnnotationsHandlers(() => [null]);
  });

  it('registers get, save, append, and dismiss handlers', () => {
    expect(mockedRegister.mock.calls.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.fileAnnotationsGet,
      IPC_CHANNELS.fileAnnotationsSave,
      IPC_CHANNELS.fileAnnotationsAppend,
      IPC_CHANNELS.fileAnnotationsDismiss,
    ]);
  });

  it('validates scope and delegates reads without broadcasting', async () => {
    mockedRead.mockResolvedValue(document);

    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsGet, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: document.filePath,
      }),
    ).resolves.toEqual(document);
    expect(mockedRead).toHaveBeenCalledWith(
      'project',
      'worktree',
      document.filePath,
    );
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: IPC_CHANNELS.fileAnnotationsSave,
      operation: mockedSave,
      request: {
        projectId: 'project',
        worktreeId: 'worktree',
        document,
        baseCommentThreadIds: [],
      },
    },
    {
      channel: IPC_CHANNELS.fileAnnotationsAppend,
      operation: mockedAppend,
      request: {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: document.filePath,
        annotations: [],
        commentThreads: [],
      },
    },
    {
      channel: IPC_CHANNELS.fileAnnotationsDismiss,
      operation: mockedDismiss,
      request: {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: document.filePath,
        annotationId: 'annotation-1',
      },
    },
  ])(
    'delegates and broadcasts $channel mutations',
    async ({ channel, operation, request }) => {
      operation.mockResolvedValue(document);

      await expect(invoke(channel, request)).resolves.toEqual(document);
      expect(operation).toHaveBeenCalledWith(request);
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.fileAnnotationsUpdated,
        {
          projectId: 'project',
          worktreeId: 'worktree',
          document,
        },
      );
    },
  );

  it('rejects invalid scope ids before persistence', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsAppend, {
        projectId: 'INVALID',
        worktreeId: 'worktree',
        filePath: document.filePath,
        annotations: [],
        commentThreads: [],
      }),
    ).rejects.toThrow('Invalid projectId');
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it.each([
    IPC_CHANNELS.fileAnnotationsSave,
    IPC_CHANNELS.fileAnnotationsAppend,
    IPC_CHANNELS.fileAnnotationsDismiss,
  ])('rejects recipient mutations through %s', async (channel) => {
    const request = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      filePath: document.filePath,
      annotationId: 'annotation-1',
      document,
      baseCommentThreadIds: [],
      annotations: [],
      commentThreads: [],
    };

    await expect(invoke(channel, request)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedAppend).not.toHaveBeenCalled();
    expect(mockedDismiss).not.toHaveBeenCalled();
  });

  it('rejects an invalid annotation id before dismissing', async () => {
    await expect(
      invoke(IPC_CHANNELS.fileAnnotationsDismiss, {
        projectId: 'project',
        worktreeId: 'worktree',
        filePath: document.filePath,
        annotationId: '../annotation',
      }),
    ).rejects.toThrow('Invalid annotationId');
    expect(mockedDismiss).not.toHaveBeenCalled();
  });
});
