import type { AnnotationOperations } from '@canopy/core-runtime/node/annotations';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { createCoreAnnotationAdapter } from '../core-annotation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

// CAN-4104: the desktop dispatcher owns core.annotation.*, checks each
// operation's grant before its handler runs, and returns validated results.

const document = {
  file: { kind: 'root', rootId: 'repo', path: 'a.ts' } as const,
  revision: 1,
  annotations: [],
  commentThreads: [],
};

type MockOperations = {
  [Name in keyof AnnotationOperations]: jest.Mock;
};

function operations(): MockOperations {
  return {
    getDocument: jest.fn(() => Promise.resolve({ document })),
    saveDocument: jest.fn(() => Promise.resolve({ document })),
    appendAnnotations: jest.fn(() => Promise.resolve({ document })),
    dismissAnnotation: jest.fn(() => Promise.resolve({ document })),
    getThread: jest.fn(),
    listThreads: jest.fn(() => Promise.resolve({ threads: [] })),
    replyToThread: jest.fn(() => Promise.resolve({ document, resolved: true })),
  };
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});

const scope = { projectId: 'project', worktreeId: 'worktree' };

describe('desktop dispatcher core.annotation.*', () => {
  it('denies a caller without the operation grant before the handler runs', async () => {
    const ops = operations();
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish: jest.fn(() => Promise.resolve()),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      await expect(
        dispatcher.query(
          'core.annotation.document.get',
          { scope, file: document.file },
          { caller: caller(['core.chat.read', 'core.annotation.write']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.instruction(
          'core.annotation.document.save',
          {
            scope,
            document: {
              file: document.file,
              annotations: [],
              commentThreads: [],
            },
            baseCommentThreadIds: [],
          },
          { caller: caller(['core.annotation.read']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.instruction(
          'core.annotation.thread.reply',
          { scope, threadId: 't', body: 'b', resolve: false },
          { caller: caller(['core.annotation.read']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(ops.getDocument).not.toHaveBeenCalled();
      expect(ops.saveDocument).not.toHaveBeenCalled();
      expect(ops.replyToThread).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('serves each operation with exactly its grant', async () => {
    const ops = operations();
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish: jest.fn(() => Promise.resolve()),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      const read = { caller: caller(['core.annotation.read']) };
      const write = { caller: caller(['core.annotation.write']) };
      await expect(
        dispatcher.query(
          'core.annotation.document.get',
          { scope, file: document.file },
          read,
        ),
      ).resolves.toEqual({ document });
      await expect(
        dispatcher.query('core.annotation.thread.list', { scope }, read),
      ).resolves.toEqual({ threads: [] });
      await expect(
        dispatcher.instruction(
          'core.annotation.document.append',
          { scope, file: document.file, annotations: [], commentThreads: [] },
          write,
        ),
      ).resolves.toEqual({ document });
      await expect(
        dispatcher.instruction(
          'core.annotation.document.dismiss',
          {
            scope,
            file: document.file,
            annotationId: 'ann-1',
            expectedRevision: 1,
          },
          write,
        ),
      ).resolves.toEqual({ document });
      expect(ops.dismissAnnotation).toHaveBeenCalledWith({
        scope,
        file: document.file,
        annotationId: 'ann-1',
        expectedRevision: 1,
      });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses params that carry a host path, before the handler runs', async () => {
    const ops = operations();
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish: jest.fn(() => Promise.resolve()),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      const invalidDocumentParams = {
        scope,
        file: { kind: 'root' as const, rootId: 'repo', path: 'a.ts' },
      };
      // Preserve the legacy malformed payload exactly at the dispatcher boundary.
      Reflect.deleteProperty(invalidDocumentParams, 'file');
      Reflect.set(invalidDocumentParams, 'filePath', '/abs/a.ts');
      await expect(
        dispatcher.query(
          'core.annotation.document.get',
          invalidDocumentParams,
          { caller: caller(['core.annotation.read']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(ops.getDocument).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('turns a result that leaks a host path into a redacted internal error', async () => {
    const ops = operations();
    ops.getDocument.mockResolvedValue({
      document: {
        ...document,
        annotations: [],
        commentThreads: [],
        file: { kind: 'root', rootId: 'repo', path: '/abs/a.ts' },
      },
    });
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish: jest.fn(() => Promise.resolve()),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      await expect(
        dispatcher.query(
          'core.annotation.document.get',
          { scope, file: document.file },
          { caller: caller(['core.annotation.read']) },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('publishes each committed write once, after its operation settles, and never a read or a failed write', async () => {
    const ops = operations();
    const order: string[] = [];
    ops.saveDocument.mockImplementation(async () => {
      await Promise.resolve();
      order.push('committed');
      return { document };
    });
    ops.appendAnnotations.mockRejectedValue(new Error('write failed'));
    const publish = jest.fn((): Promise<void> => {
      order.push('published');
      return Promise.resolve();
    });
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish,
      }),
      shutdownTimeoutMs: 25,
    });
    const write = { caller: caller(['core.annotation.write']) };
    try {
      await dispatcher.instruction(
        'core.annotation.document.save',
        {
          scope,
          document: {
            file: document.file,
            annotations: [],
            commentThreads: [],
          },
          baseCommentThreadIds: [],
        },
        write,
      );
      expect(order).toEqual(['committed', 'published']);
      expect(publish).toHaveBeenCalledWith(scope, document);
      await dispatcher.instruction(
        'core.annotation.thread.reply',
        { scope, threadId: 't', body: 'b', resolve: true },
        write,
      );
      await dispatcher.instruction(
        'core.annotation.document.dismiss',
        { scope, file: document.file, annotationId: 'ann-1' },
        write,
      );
      expect(publish).toHaveBeenCalledTimes(3);
      await expect(
        dispatcher.instruction(
          'core.annotation.document.append',
          { scope, file: document.file, annotations: [], commentThreads: [] },
          write,
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
      await dispatcher.query(
        'core.annotation.thread.list',
        { scope },
        { caller: caller(['core.annotation.read']) },
      );
      expect(publish).toHaveBeenCalledTimes(3);
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('acknowledges a committed write whose publication fails', async () => {
    const ops = operations();
    const dispatcher = createDesktopRuntime({
      annotationAdapter: createCoreAnnotationAdapter({
        operations: ops,
        publish: () => Promise.reject(new Error('window gone')),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      await expect(
        dispatcher.instruction(
          'core.annotation.document.dismiss',
          { scope, file: document.file, annotationId: 'ann-1' },
          { caller: caller(['core.annotation.write']) },
        ),
      ).resolves.toEqual({ document });
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses writes to a read-only scope from any binding, as a typed error', async () => {
    // The renderer relay reaches these instructions with every relay grant and
    // without the IPC projection's read-only check; the adapter must refuse.
    const dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
    const readOnly = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    };
    const write = { caller: caller(['core.annotation.write']) };
    const refused = {
      payload: {
        kind: 'permission_denied',
        code: 'core.annotation.readOnlyScope',
        details: { reason: 'READ_ONLY_SCOPE' },
      },
    };
    try {
      await expect(
        dispatcher.instruction(
          'core.annotation.document.save',
          {
            scope: readOnly,
            document: {
              file: document.file,
              annotations: [],
              commentThreads: [],
            },
            baseCommentThreadIds: [],
          },
          write,
        ),
      ).rejects.toMatchObject(refused);
      await expect(
        dispatcher.instruction(
          'core.annotation.document.append',
          {
            scope: readOnly,
            file: document.file,
            annotations: [],
            commentThreads: [],
          },
          write,
        ),
      ).rejects.toMatchObject(refused);
      await expect(
        dispatcher.instruction(
          'core.annotation.document.dismiss',
          { scope: readOnly, file: document.file, annotationId: 'ann-1' },
          write,
        ),
      ).rejects.toMatchObject(refused);
      await expect(
        dispatcher.instruction(
          'core.annotation.thread.reply',
          { scope: readOnly, threadId: 't', body: 'b', resolve: true },
          write,
        ),
      ).rejects.toMatchObject(refused);
    } finally {
      await dispatcher.shutdown();
    }
  });
});
