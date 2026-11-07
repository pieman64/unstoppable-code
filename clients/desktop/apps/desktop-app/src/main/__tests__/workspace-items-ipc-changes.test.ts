// CAN-4152 deliberate changes to the note and prompt IPC channels, pinned
// through the registered handlers, the production caller resolver and a real
// data root. Everything else is pinned unchanged by workspace-items-ipc-golden.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

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
    [
      'mkdir',
      'open',
      'readFile',
      'readdir',
      'rename',
      'rm',
      'stat',
      'writeFile',
    ].map((name) => {
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

jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
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
const mockPublished: string[] = [];
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: (projectId: string) => Promise<void>;
  } => ({
    scheduleWorkspace: (projectId: string): Promise<void> => {
      mockPublished.push(projectId);
      return Promise.resolve();
    },
  }),
}));

import { registerWorkspaceItemHandlers } from '../ipc/workspace-items';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  readSharedContainerFileScope,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';
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
const bridge = makeSender(3);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-items-changes-')));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerWorkspaceTypes(
    new Map([
      ['code-ws', 'single-repo'],
      ['cowork-ws', 'cowork'],
    ]),
  );
  mockPublished.length = 0;
  runtime = createDesktopRuntime();
  registerWorkspaceItemHandlers({
    dispatcher: runtime,
    // The production resolver, with this suite's window as the tracked set
    // and one live remote-control bridge.
    resolveCaller: (event: DesktopIpcEvent): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => [tracked.window],
        packagedRendererUrls: [RENDERER_URL],
        resolveRemoteBridgeSender: (sender) =>
          sender === bridge.event.sender ? 'controller-device' : null,
      }),
  });
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
  return {
    message: message.split(dir).join('<root>'),
    ...(typeof kind === 'string' ? { kind } : {}),
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

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const KINDS = [
  {
    kind: 'note',
    list: IPC_CHANNELS.workspaceNotesList,
    read: IPC_CHANNELS.workspaceNotesRead,
    save: IPC_CHANNELS.workspaceNotesSave,
    delete: IPC_CHANNELS.workspaceNotesDelete,
    idKey: 'noteId',
    folder: 'notes',
  },
  {
    kind: 'prompt',
    list: IPC_CHANNELS.workspacePromptsList,
    read: IPC_CHANNELS.workspacePromptsRead,
    save: IPC_CHANNELS.workspacePromptsSave,
    delete: IPC_CHANNELS.workspacePromptsDelete,
    idKey: 'promptId',
    folder: 'prompts',
  },
] as const;

describe('CAN-4152 note and prompt IPC deliberate changes', () => {
  it.each(KINDS)(
    'refuses a sender the caller resolver does not track on every $kind channel',
    async (channels) => {
      const refused = {
        error: {
          message: 'Untrusted desktop IPC sender.',
          kind: 'permission_denied',
        },
      };
      const seeded = await ipc(channels.save, {
        projectId: 'code-ws',
        title: 'Seeded',
        content: 'seed',
      });
      expect(seeded).toMatchObject({ result: { id: 'seeded' } });
      mockPublished.length = 0;
      expect(
        await ipc(channels.list, { projectId: 'code-ws' }, untracked.event),
      ).toEqual(refused);
      expect(
        await ipc(
          channels.read,
          { projectId: 'code-ws', [channels.idKey]: 'seeded' },
          untracked.event,
        ),
      ).toEqual(refused);
      expect(
        await ipc(
          channels.save,
          { projectId: 'code-ws', title: 'Intruder', content: 'x' },
          untracked.event,
        ),
      ).toEqual(refused);
      expect(
        await ipc(
          channels.delete,
          { projectId: 'code-ws', [channels.idKey]: 'seeded' },
          untracked.event,
        ),
      ).toEqual(refused);
      const store = join(dataDir, 'workspaces', 'code-ws', channels.folder);
      expect(existsSync(join(store, 'intruder.md'))).toBe(false);
      expect(existsSync(join(store, 'seeded.md'))).toBe(true);
      await flush();
      expect(mockPublished).toEqual([]);
    },
  );

  it.each(KINDS)(
    'serves a paired remote device through the bridge on every $kind channel, side effects included',
    async (channels) => {
      const saved = await ipc(
        channels.save,
        { projectId: 'code-ws', title: 'From remote', content: 'r' },
        bridge.event,
      );
      expect(saved).toMatchObject({ result: { id: 'from-remote' } });
      const listed = await ipc(
        channels.list,
        { projectId: 'code-ws' },
        bridge.event,
      );
      expect(listed).toMatchObject({ result: [{ id: 'from-remote' }] });
      expect(
        await ipc(
          channels.read,
          { projectId: 'code-ws', [channels.idKey]: 'from-remote' },
          bridge.event,
        ),
      ).toMatchObject({ result: { content: 'r' } });
      expect(
        await ipc(
          channels.delete,
          { projectId: 'code-ws', [channels.idKey]: 'from-remote' },
          bridge.event,
        ),
      ).toEqual({ result: undefined });
      await flush();
      expect(mockPublished).toEqual(['code-ws', 'code-ws']);
    },
  );

  it.each(KINDS)(
    'leaves selections and publication alone for a code $kind delete of a missing item',
    async (channels) => {
      const scope = {
        includedPaths: [],
        includedNoteIds: ['ghost'],
        excludedNoteIds: ['ghost'],
        includedPromptIds: ['ghost'],
        excludedPromptIds: ['ghost'],
      };
      await writeSharedContainerFileScope('code-ws', 'wt-1', scope);
      // Before CAN-4152 the channel removed `ghost` and scheduled publication.
      expect(
        await ipc(channels.delete, {
          projectId: 'code-ws',
          [channels.idKey]: 'ghost',
        }),
      ).toEqual({ result: undefined });
      await flush();
      expect(mockPublished).toEqual([]);
      expect(
        await readSharedContainerFileScope('code-ws', 'wt-1'),
      ).toMatchObject(scope);
    },
  );
  it.each(KINDS)(
    'keeps concurrent saves of one $kind last-writer-wins, without conflicts',
    async (channels) => {
      // Each save pre-reads the revision the upsert compares, so concurrent
      // channel saves would otherwise refuse each other.
      const seeded = await ipc(channels.save, {
        projectId: 'code-ws',
        title: 'Same',
        content: 'v0',
      });
      expect(seeded).toMatchObject({ result: { id: 'same' } });
      const versions = ['v1', 'v2', 'v3', 'v4', 'v5'];
      const saves = await Promise.all(
        versions.map((content) =>
          ipc(channels.save, {
            projectId: 'code-ws',
            [channels.idKey]: 'same',
            title: 'Same',
            content,
          }),
        ),
      );
      for (const save of saves)
        expect(save).toMatchObject({ result: { id: 'same' } });
      const store = join(dataDir, 'workspaces', 'code-ws', channels.folder);
      expect(readdirSync(store).sort()).toEqual(['index.json', 'same.md']);
      expect(readFileSync(join(store, 'same.md'), 'utf8')).toMatch(/v5$/);
    },
  );

  it.each(KINDS)(
    'saves an edit racing a rename of one $kind as a new item',
    async (channels) => {
      await ipc(channels.save, {
        projectId: 'code-ws',
        title: 'Old',
        content: 'v0',
      });
      const [renamed, edited] = await Promise.all([
        ipc(channels.save, {
          projectId: 'code-ws',
          [channels.idKey]: 'old',
          title: 'New',
          content: 'renamed',
        }),
        ipc(channels.save, {
          projectId: 'code-ws',
          [channels.idKey]: 'old',
          title: 'Old',
          content: 'edited',
        }),
      ]);
      expect(renamed).toMatchObject({ result: { id: 'new' } });
      expect(edited).toMatchObject({ result: { id: 'old' } });
      const store = join(dataDir, 'workspaces', 'code-ws', channels.folder);
      expect(readFileSync(join(store, 'new.md'), 'utf8')).toMatch(/renamed$/);
      expect(readFileSync(join(store, 'old.md'), 'utf8')).toMatch(/edited$/);
    },
  );

  // Windows does not enforce chmod read bits, and root reads any file.
  const unreadable =
    process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

  unreadable.each(KINDS)(
    'refuses to delete a $kind whose file cannot be read',
    async (channels) => {
      // Before CAN-4152 the channel removed it unread. A delete now needs the
      // item's revision, so an unreadable file stays and the read error is
      // thrown.
      await ipc(channels.save, {
        projectId: 'code-ws',
        title: 'Locked',
        content: 'x',
      });
      const file = join(
        dataDir,
        'workspaces',
        'code-ws',
        channels.folder,
        'locked.md',
      );
      chmodSync(file, 0o000);
      try {
        const deleted = await ipc(channels.delete, {
          projectId: 'code-ws',
          [channels.idKey]: 'locked',
        });
        expect(deleted).toMatchObject({ error: { message: /EACCES/ } });
        expect(existsSync(file)).toBe(true);
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );
});
