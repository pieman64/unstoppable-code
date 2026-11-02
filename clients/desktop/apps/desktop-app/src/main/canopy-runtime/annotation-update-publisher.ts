import { AsyncLocalStorage } from 'node:async_hooks';
import {
  IPC_CHANNELS,
  type FileAnnotationsUpdatedEvent,
} from '@canopy/desktop-shared/types';
import type {
  AnnotationScope,
  CanonicalFileAnnotationDocument,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  sendToAllWindows,
  sendToWindow,
  type SendableBrowserWindow,
} from '../lib/window-send';
import {
  createHostAnnotationProjection,
  toHostFileAnnotationDocument,
} from './annotation-legacy-projection';

/*
 * `file-annotations:updated`, published by the core.annotation adapter once a
 * write has committed, whichever binding dispatched it. Renderers receive the
 * host-path document. A write through the `file-annotations:*` IPC projection
 * reaches the windows that projection serves; any other write (agent tools,
 * renderer relay) reaches every window.
 */

type UpdateWindows = () => ReadonlyArray<SendableBrowserWindow | null>;

const ipcUpdateWindows = new AsyncLocalStorage<UpdateWindows>();

/** Runs an IPC projection's write so its update reaches `windows`. */
export function withFileAnnotationsUpdateWindows<Result>(
  windows: UpdateWindows,
  write: () => Promise<Result>,
): Promise<Result> {
  // Async, so a synchronous throw (an untrusted sender) still rejects.
  return ipcUpdateWindows.run(windows, async () => write());
}

/** Never throws: the write it announces is already durable. */
export async function publishFileAnnotationsUpdated(
  scope: AnnotationScope,
  document: CanonicalFileAnnotationDocument,
): Promise<void> {
  try {
    const event: FileAnnotationsUpdatedEvent = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      document: toHostFileAnnotationDocument(
        document,
        await createHostAnnotationProjection(scope),
      ),
    };
    const windows = ipcUpdateWindows.getStore();
    if (!windows) {
      sendToAllWindows(IPC_CHANNELS.fileAnnotationsUpdated, event);
      return;
    }
    for (const window of windows()) {
      sendToWindow(window, IPC_CHANNELS.fileAnnotationsUpdated, event);
    }
  } catch (error) {
    logMainProcessWarn('[file-annotations] update was not published', error);
  }
}
