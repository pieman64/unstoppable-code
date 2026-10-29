import { constants } from 'node:fs';
import type {
  FileDocumentBytesRequest,
  FileDocumentBytesResponse,
} from '@canopy/desktop-shared/types';
import { documentInvokeEvent, documentRoots } from './file-preview-fixtures';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));
jest.mock('electron', () => ({
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

import { registerIpcHandler } from '../ipc/register';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import { registerFilePreviewHandlers } from '../ipc/file-preview';

// Real filesystem regression: an open('r') on a FIFO with no writer hangs.
(process.platform === 'win32' ? it.skip : it)(
  'rejects a real PDF-named FIFO without an outstanding open',
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-fifo-'));
    const fifoPath = path.join(directory, 'brief.pdf');
    execFileSync('mkfifo', [fifoPath]);
    jest
      .mocked(getFileBrowserRoots)
      .mockResolvedValue(documentRoots(directory));
    registerFilePreviewHandlers();
    const registration = jest
      .mocked(
        registerIpcHandler<
          [FileDocumentBytesRequest],
          FileDocumentBytesResponse
        >,
      )
      .mock.calls.find(([channel]) => channel === 'file:read-document-bytes');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let operation: Promise<unknown> | undefined;
    try {
      expect(registration).toBeDefined();
      if (!registration)
        throw new Error('Document byte handler was not registered');
      const handler = registration[1];
      operation = Promise.resolve(
        handler(documentInvokeEvent, {
          absolutePath: fifoPath,
          workspaceTarget: { projectId: 'project-1', worktreeId: 'worktree-1' },
        }),
      );
      const result = operation.then(
        () => {
          settled = true;
          return 'accepted';
        },
        (error: Error) => {
          settled = true;
          return error.message;
        },
      );
      const outcome = await Promise.race([
        result,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('timed out'), 1000);
        }),
      ]);
      expect(outcome).toMatch(/regular file/);
      expect(settled).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      // Unblock and await a naive implementation on regression so Jest itself
      // never leaves a blocked libuv open behind after the timeout assertion.
      if (operation && !settled) {
        const writer = await fs.open(
          fifoPath,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        await writer.close();
        await operation.catch(() => {});
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
