// CAN-4105 deliberate changes to the attachment IPC channels, pinned through
// the registered handlers, the production caller resolver and a real data
// root. Everything else is pinned unchanged by attachment-import-ipc-golden.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';

// Jest runs tests in a separate realm, so built-in fs errors fail the
// production `instanceof Error` checks. Rethrow them as same-realm errors with
// the same fields, which is what Electron main sees.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<Record<string, unknown>>('node:fs/promises');
  const sameRealm = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && !(error instanceof Error)
      ? Object.assign(new Error(String(Reflect.get(error, 'message'))), error)
      : error;
  const wrapped = Object.fromEntries(
    ['copyFile', 'mkdir', 'readdir', 'rm', 'stat', 'writeFile'].map((name) => {
      const original = actual[name];
      if (typeof original !== 'function') throw new Error(name);
      return [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          try {
            return await Reflect.apply(original, actual, args);
          } catch (error) {
            throw sameRealm(error);
          }
        },
      ];
    }),
  );
  return { ...actual, ...wrapped };
});

const mockShowOpenDialog = jest.fn<
  Promise<{ canceled: boolean; filePaths: string[] }>,
  unknown[]
>(() => Promise.resolve({ canceled: true, filePaths: [] }));
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (
      ...args: unknown[]
    ): Promise<{ canceled: boolean; filePaths: string[] }> =>
      mockShowOpenDialog(...args),
  },
  BrowserWindow: { fromWebContents: (): null => null },
}));

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: () => Promise<void>;
  } => ({ scheduleWorkspace: (): Promise<void> => Promise.resolve() }),
}));

import { registerWorktreeAttachmentHandlers } from '../ipc/worktree-attachments';
import { registerWorkspaceItemHandlers } from '../ipc/workspace-items';
import {
  copyAttachmentFileToDir,
  writeClipboardAttachmentToDir,
} from '../lib/standalone-workspace-files';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  deriveDesktopIpcCaller,
  type DesktopAppWindow,
  type DesktopIpcEvent,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../canopy-runtime/desktop-ipc-caller';

jest.setTimeout(60_000);

const RENDERER_URL = pathToFileURL('/app/renderer/index.html').href;

function makeSender(id: number): {
  event: DesktopIpcEvent;
  window: DesktopAppWindow;
} {
  const mainFrame: DesktopIpcFrame = {
    url: RENDERER_URL,
    detached: false,
    isDestroyed: () => false,
  };
  const sender: DesktopIpcSender = {
    id,
    mainFrame,
    getURL: () => RENDERER_URL,
    isDestroyed: () => false,
  };
  return {
    event: { sender, senderFrame: mainFrame },
    window: { isDestroyed: () => false, webContents: sender },
  };
}

const tracked = makeSender(1);
const untracked = makeSender(2);

let dir: string;
let dataDir: string;
let sourceDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-ipc-changes-')));
  dataDir = join(dir, 'data');
  sourceDir = join(dir, 'source');
  mkdirSync(dataDir);
  mkdirSync(sourceDir);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerWorkspaceTypes(new Map([['code-ws', 'single-repo']]));
  mockShowOpenDialog.mockReset();
  mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  runtime = createDesktopRuntime();
  const access = {
    dispatcher: runtime,
    // The production resolver, with this suite's window as the tracked set.
    resolveCaller: (event: DesktopIpcEvent): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => [tracked.window],
        packagedRendererUrls: [RENDERER_URL],
      }),
  };
  registerWorktreeAttachmentHandlers(access);
  registerWorkspaceItemHandlers(access);
});

afterEach(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

// Realm-agnostic: Jest's fs errors are not instances of this realm's Error.
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return { thrown: error };
  const message: unknown = Reflect.get(error, 'message');
  if (typeof message !== 'string') return { thrown: 'object without message' };
  const payload: unknown = Reflect.get(error, 'payload');
  const kind: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'kind')
      : undefined;
  const code: unknown = Reflect.get(error, 'code');
  return {
    message: message.split(dir).join('<root>'),
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

async function ipc(
  channel: string,
  request: unknown,
  event: DesktopIpcEvent = tracked.event,
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

function source(name: string, content: string): string {
  const path = join(sourceDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function storeContents(store: string): Record<string, string> {
  if (!existsSync(store)) return {};
  return Object.fromEntries(
    readdirSync(store)
      .sort()
      .map((name) => [name, readFileSync(join(store, name), 'utf8')]),
  );
}

const codeStore = (): string =>
  join(dataDir, 'workspaces/code-ws/attachments/wt-1');

describe('CAN-4105 attachment IPC deliberate changes', () => {
  it('refuses a sender the caller resolver does not track, before the chooser', async () => {
    const refused = {
      error: {
        message: 'Untrusted desktop IPC sender.',
        kind: 'permission_denied',
      },
    };
    const request = { projectId: 'code-ws', worktreeId: 'wt-1', filePaths: [] };
    expect({
      worktree: await ipc(
        IPC_CHANNELS.worktreeImportAttachments,
        request,
        untracked.event,
      ),
      items: await ipc(
        IPC_CHANNELS.workspaceAttachmentsImport,
        request,
        untracked.event,
      ),
      list: await ipc(
        IPC_CHANNELS.workspaceAttachmentsList,
        request,
        untracked.event,
      ),
    }).toEqual({ worktree: refused, items: refused, list: refused });
    // Before CAN-4105 the imports opened the chooser and the list answered.
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it('refuses the read-only viewer on the worktree channel before the chooser', async () => {
    const result = await ipc(IPC_CHANNELS.worktreeImportAttachments, {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'wt-1',
      filePaths: [source('a.txt', 'a')],
    });
    // Before CAN-4105 the copy landed in the viewer's app-managed folder.
    expect(result).toEqual({
      error: { message: 'Shared-container recipient workspaces are read-only' },
    });
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'app-workspaces'))).toBe(false);
  });

  it('stops the worktree channel at its first failed source', async () => {
    const result = await ipc(IPC_CHANNELS.worktreeImportAttachments, {
      projectId: 'code-ws',
      worktreeId: 'wt-1',
      filePaths: [join(sourceDir, 'missing.txt'), source('later.txt', 'l')],
      clipboardItems: [{ filename: 'clip.png', data: Buffer.from('c') }],
    });
    // Before CAN-4105 the parallel copy of later.txt still landed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result).toEqual({
      error: {
        message:
          "ENOENT: no such file or directory, stat '<root>/source/missing.txt'",
        code: 'ENOENT',
      },
    });
    expect(storeContents(codeStore())).toEqual({});
  });

  it('keeps every same-name source of one worktree call', async () => {
    for (let round = 0; round < 10; round += 1) {
      rmSync(codeStore(), { recursive: true, force: true });
      const result = await ipc(IPC_CHANNELS.worktreeImportAttachments, {
        projectId: 'code-ws',
        worktreeId: 'wt-1',
        filePaths: [source('a/x.txt', 'one'), source('b/x.txt', 'two')],
        clipboardItems: [
          { filename: 'x.txt', data: Buffer.from('three') },
          { filename: 'x.txt', data: Buffer.from('four') },
        ],
      });
      // Before CAN-4105 parallel copies chose the same free name.
      expect(storeContents(codeStore())).toEqual({
        'x.txt': 'one',
        'x-2.txt': 'two',
        'x-3.txt': 'three',
        'x-4.txt': 'four',
      });
      expect(result).toMatchObject({
        result: {
          attachments: ['x.txt', 'x-2.txt', 'x-3.txt', 'x-4.txt'].map(
            (filename) => ({ filename }),
          ),
        },
      });
    }
  });

  it('keeps every file of concurrent imports into one folder', async () => {
    const calls = Array.from({ length: 12 }, (_, index) =>
      ipc(
        index % 2 === 0
          ? IPC_CHANNELS.worktreeImportAttachments
          : IPC_CHANNELS.workspaceAttachmentsImport,
        {
          projectId: 'code-ws',
          worktreeId: 'wt-1',
          filePaths:
            index % 3 === 0 ? [] : [source(`${index}/x.txt`, `f${index}`)],
          clipboardItems:
            index % 3 === 0
              ? [{ filename: 'x.txt', data: Buffer.from(`c${index}`) }]
              : undefined,
        },
      ),
    );
    const results = await Promise.all(calls);
    expect(results.every((result) => 'result' in result)).toBe(true);
    const contents = Object.values(storeContents(codeStore())).sort();
    // Before CAN-4105 concurrent pastes could overwrite one another.
    expect(contents).toEqual(
      Array.from({ length: 12 }, (_, index) =>
        index % 3 === 0 ? `c${index}` : `f${index}`,
      ).sort(),
    );
  });
});

const posixLinks = process.platform === 'win32' ? describe.skip : describe;

posixLinks('CAN-4105 exclusive attachment create', () => {
  it('never copies through a dangling link that holds the free name', async () => {
    const store = join(dir, 'store');
    mkdirSync(store);
    symlinkSync(join(dir, 'outside.txt'), join(store, 'x.txt'));
    const copied = await copyAttachmentFileToDir(
      store,
      source('x.txt', 'body'),
    );
    // Before CAN-4105 the copy followed the link and wrote outside.
    expect(copied.filename).toBe('x-2.txt');
    expect(existsSync(join(dir, 'outside.txt'))).toBe(false);
    expect(readFileSync(join(store, 'x-2.txt'), 'utf8')).toBe('body');
  });

  it('never writes or removes a dangling link that holds the free name', async () => {
    const store = join(dir, 'store');
    mkdirSync(store);
    symlinkSync(join(dir, 'outside.png'), join(store, 'paste.png'));
    const written = await writeClipboardAttachmentToDir(store, {
      filename: 'paste.png',
      data: Buffer.from('png'),
    });
    expect(written.filename).toBe('paste-2.png');
    expect(existsSync(join(dir, 'outside.png'))).toBe(false);
    expect(readdirSync(store).sort()).toEqual(['paste-2.png', 'paste.png']);
  });
});
