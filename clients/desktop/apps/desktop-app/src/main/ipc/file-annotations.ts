import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type FileAnnotationDocument,
  type FileAnnotationsAppendRequest,
  type FileAnnotationsDismissRequest,
  type FileAnnotationsGetRequest,
  type FileAnnotationsSaveRequest,
  type FileAnnotationsUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  appendFileAnnotations,
  dismissFileAnnotation,
  readFileAnnotationDocument,
  saveFileAnnotationDocument,
} from '../lib/file-annotations-persistence';
import { sendToWindow } from '../lib/window-send';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { registerIpcHandler } from './register';

export function registerFileAnnotationsHandlers(
  getWindows: () => Array<BrowserWindow | null>,
): void {
  const validateScope = (request: {
    projectId: string;
    worktreeId: string;
  }): void => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
  };

  const broadcast = (
    request: { projectId: string; worktreeId: string },
    document: FileAnnotationDocument,
  ): void => {
    const event: FileAnnotationsUpdatedEvent = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      document,
    };
    for (const window of getWindows()) {
      sendToWindow(window, IPC_CHANNELS.fileAnnotationsUpdated, event);
    }
  };

  registerIpcHandler<[FileAnnotationsGetRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsGet,
    async (_event, request) => {
      validateScope(request);
      return readFileAnnotationDocument(
        request.projectId,
        request.worktreeId,
        request.filePath,
      );
    },
  );

  registerIpcHandler<[FileAnnotationsSaveRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsSave,
    async (_event, request) => {
      validateScope(request);
      assertWritableScope(request.projectId);
      const document = await saveFileAnnotationDocument(request);
      broadcast(request, document);
      return document;
    },
  );

  registerIpcHandler<[FileAnnotationsAppendRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsAppend,
    async (_event, request) => {
      validateScope(request);
      assertWritableScope(request.projectId);
      const document = await appendFileAnnotations(request);
      broadcast(request, document);
      return document;
    },
  );

  registerIpcHandler<[FileAnnotationsDismissRequest], FileAnnotationDocument>(
    IPC_CHANNELS.fileAnnotationsDismiss,
    async (_event, request) => {
      validateScope(request);
      assertWritableScope(request.projectId);
      validateId(request.annotationId, 'annotationId');
      const document = await dismissFileAnnotation(request);
      broadcast(request, document);
      return document;
    },
  );
}
