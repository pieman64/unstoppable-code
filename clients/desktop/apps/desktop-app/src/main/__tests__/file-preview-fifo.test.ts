import { constants } from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  FileContentRequest,
  FileContentResponse,
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
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

const workspaceTarget = { projectId: 'project-1', worktreeId: 'worktree-1' };

/**
 * Runs `invoke` against a real FIFO with no writer and returns the rejection
 * message, `accepted`, or `timed out` after one second. On regression it
 * unblocks the hung open so Jest never leaves a blocked libuv open behind.
 */
async function invokeOnFifo(
  fileName: string,
  invoke: (fifoPath: string) => Promise<unknown>,
): Promise<{ outcome: string; settled: boolean }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-fifo-'));
  const fifoPath = path.join(directory, fileName);
  execFileSync('mkfifo', [fifoPath]);
  jest.mocked(getFileBrowserRoots).mockResolvedValue(documentRoots(directory));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let operation: Promise<unknown> | undefined;
  try {
    operation = invoke(fifoPath);
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
    return { outcome, settled };
  } finally {
    if (timer) clearTimeout(timer);
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
}

function registeredHandler<Args extends unknown[], Result>(
  channel: string,
): (...args: [IpcMainInvokeEvent, ...Args]) => Result | Promise<Result> {
  const registration = jest
    .mocked(registerIpcHandler<Args, Result>)
    .mock.calls.find(([candidate]) => candidate === channel);
  if (!registration) throw new Error(`${channel} was not registered`);
  return registration[1];
}

let runtime: DesktopCanopyDispatcher | undefined;

beforeEach(() => {
  jest.mocked(registerIpcHandler).mockClear();
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(runtime, () => ({
    principalId: 'local',
    clientInstanceId: 'electron-web-contents:41',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  }));
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

// Real filesystem regression: an open('r') on a FIFO with no writer hangs.
(process.platform === 'win32' ? it.skip : it)(
  'rejects a real PDF-named FIFO without an outstanding open',
  async () => {
    const handler = registeredHandler<
      [FileDocumentBytesRequest],
      FileDocumentBytesResponse
    >('file:read-document-bytes');
    const { outcome, settled } = await invokeOnFifo('brief.pdf', (fifoPath) =>
      Promise.resolve(
        handler(documentInvokeEvent, {
          absolutePath: fifoPath,
          workspaceTarget,
        }),
      ),
    );
    expect(outcome).toMatch(/regular file/);
    expect(settled).toBe(true);
  },
);

// CAN-4099 deliberate difference: the scoped preview read refuses a FIFO
// before opening it instead of blocking on it.
(process.platform === 'win32' ? it.skip : it)(
  'rejects a scoped content read of a real FIFO without blocking',
  async () => {
    const handler = registeredHandler<
      [FileContentRequest],
      FileContentResponse
    >('file:read-content');
    const { outcome, settled } = await invokeOnFifo('notes.txt', (fifoPath) => {
      // This test intentionally provides only sender.id to the handler.
      const event = Object.create(null) as IpcMainInvokeEvent;
      Reflect.set(event, 'sender', { id: 41 });
      return Promise.resolve(
        handler(event, {
          absolutePath: fifoPath,
          workspaceTarget,
        }),
      );
    });
    expect(outcome).toMatch(/regular file/);
    expect(settled).toBe(true);
  },
);
