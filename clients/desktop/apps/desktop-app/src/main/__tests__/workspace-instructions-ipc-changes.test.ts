// CAN-4106 deliberate behavior changes on the `workspace:*-claude-md` IPC
// handlers, recorded in the CAN-4106 behavior inventory. The base handlers
// ignored the sender, passed any content to writeFile after creating the
// folder, and kept writing after the dispatcher stopped. Real data root and
// real dispatcher; only handler registration, telemetry and unrelated side
// channels are mocked.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

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
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../memory/local/import/import-job', () => ({
  enqueueWorkspaceLocalMemoryImportBatch: jest.fn(() => Promise.resolve()),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { registerWorkspaceHandlers } from '../ipc/workspaces';
import { recordWorkspaceCrudTelemetry } from '../lib/desktop-telemetry';
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

jest.setTimeout(30_000);

const RENDERER_URL = pathToFileURL('/app/renderer/index.html').href;
const mockedTelemetry = jest.mocked(recordWorkspaceCrudTelemetry);

let dir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
let appWindows: DesktopAppWindow[];

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

function workspaceDir(id: string): string {
  return join(dir, 'workspaces', id);
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const payload: unknown = Reflect.get(error, 'payload');
  const kind: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'kind')
      : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(typeof kind === 'string' ? { kind } : {}),
  };
}

async function ipc(
  channel: string,
  event: DesktopIpcEvent,
  request: unknown,
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const load = (
  event: DesktopIpcEvent,
  request: unknown,
): Promise<Record<string, unknown>> =>
  ipc(IPC_CHANNELS.workspaceLoadClaudeMd, event, request);
const save = (
  event: DesktopIpcEvent,
  request: unknown,
): Promise<Record<string, unknown>> =>
  ipc(IPC_CHANNELS.workspaceSaveClaudeMd, event, request);

function register(dispatcher: DesktopCanopyDispatcher): void {
  registerWorkspaceHandlers(() => null, {
    dispatcher,
    // The production resolver, with this suite's windows as the tracked set.
    resolveCaller: (event): CanopyCallerDescriptor =>
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => appWindows,
        packagedRendererUrls: [RENDERER_URL],
      }),
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'instructions-ipc-changes-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dir;
  appWindows = [tracked.window];
  mockedTelemetry.mockClear();
  runtime = createDesktopRuntime();
  register(runtime);
});

afterEach(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('CAN-4106 workspace instructions IPC deliberate changes', () => {
  it('saves and loads for a tracked renderer sender', async () => {
    expect(
      await save(tracked.event, { workspaceId: 'ws-a', content: '# Mine' }),
    ).toEqual({ result: undefined });
    expect(await load(tracked.event, { workspaceId: 'ws-a' })).toEqual({
      result: '# Mine',
    });
  });

  it.each([42, null, undefined, { text: '# x' }, ['# x']])(
    'refuses non-string save content %p before any filesystem effect',
    async (content) => {
      expect(
        await save(tracked.event, { workspaceId: 'ws-a', content }),
      ).toEqual({
        error: {
          name: 'CanopyOperationError',
          message: 'Invalid operation parameters.',
          kind: 'invalid_argument',
        },
      });
      // The base handler created the workspace folder before writeFile failed.
      expect(existsSync(workspaceDir('ws-a'))).toBe(false);
      expect(mockedTelemetry).not.toHaveBeenCalled();
    },
  );

  it('refuses non-string content without touching an existing copy', async () => {
    await save(tracked.event, { workspaceId: 'ws-a', content: '# Kept' });
    mockedTelemetry.mockClear();
    await save(tracked.event, { workspaceId: 'ws-a', content: 7 });
    expect(readFileSync(join(workspaceDir('ws-a'), 'CLAUDE.md'), 'utf8')).toBe(
      '# Kept',
    );
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });

  it('refuses a sender the caller resolver does not track', async () => {
    const refused = {
      error: {
        name: 'CanopyOperationError',
        message: 'Untrusted desktop IPC sender.',
        kind: 'permission_denied',
      },
    };
    expect({
      load: await load(untracked.event, { workspaceId: 'ws-a' }),
      save: await save(untracked.event, {
        workspaceId: 'ws-a',
        content: '# Never',
      }),
    }).toEqual({ load: refused, save: refused });
    expect(existsSync(workspaceDir('ws-a'))).toBe(false);
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });

  it('refuses a once-tracked sender after its window closes', async () => {
    await save(tracked.event, { workspaceId: 'ws-a', content: '# Before' });
    appWindows = [];
    expect(await load(tracked.event, { workspaceId: 'ws-a' })).toMatchObject({
      error: { kind: 'permission_denied' },
    });
  });

  describe('dispatcher shutdown', () => {
    const unavailable = {
      error: {
        name: 'CanopyOperationError',
        message: 'The runtime is unavailable.',
        kind: 'unavailable',
      },
    };

    beforeEach(async () => {
      await save(tracked.event, { workspaceId: 'ws-a', content: '# Before' });
      mockedTelemetry.mockClear();
    });

    // Shutdown runs this first phase one microtask after it starts, so it is
    // entered directly here to hold the kernel in its draining state.
    it('reads but refuses save while instructions drain', async () => {
      runtime.drainInstructions();
      expect({
        load: await load(tracked.event, { workspaceId: 'ws-a' }),
        save: await save(tracked.event, {
          workspaceId: 'ws-b',
          content: '# Late',
        }),
      }).toEqual({ load: { result: '# Before' }, save: unavailable });
      expect(existsSync(workspaceDir('ws-b'))).toBe(false);
      expect(mockedTelemetry).not.toHaveBeenCalled();
    });

    it('refuses get and save once shutdown has finished', async () => {
      await runtime.shutdown();
      expect({
        load: await load(tracked.event, { workspaceId: 'ws-a' }),
        save: await save(tracked.event, {
          workspaceId: 'ws-a',
          content: '# Late',
        }),
      }).toEqual({ load: unavailable, save: unavailable });
      expect(
        readFileSync(join(workspaceDir('ws-a'), 'CLAUDE.md'), 'utf8'),
      ).toBe('# Before');
      expect(mockedTelemetry).not.toHaveBeenCalled();
    });

    it('completes a save admitted before shutdown starts', async () => {
      const inFlight = save(tracked.event, {
        workspaceId: 'ws-a',
        content: '# In flight',
      });
      await runtime.shutdown();
      expect(await inFlight).toEqual({ result: undefined });
      expect(
        readFileSync(join(workspaceDir('ws-a'), 'CLAUDE.md'), 'utf8'),
      ).toBe('# In flight');
      expect(mockedTelemetry).toHaveBeenCalledTimes(1);
    });
  });
});
