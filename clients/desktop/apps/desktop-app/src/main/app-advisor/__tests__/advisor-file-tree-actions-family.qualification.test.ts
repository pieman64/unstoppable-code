import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  FileTreeMutationRequest,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorFileTreeActionHost } from '../advisor-file-tree-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorFileTreeActionHost;
const mockHostOptions: unknown[] = [];
jest.mock('../advisor-file-tree-actions-host', () => ({
  mainAdvisorFileTreeActionHost: (
    options: unknown,
  ): AdvisorFileTreeActionHost => {
    mockHostOptions.push(options);
    return mockHost;
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_FILE_TREE_ACTION_TYPES } from '../advisor-file-tree-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const SCOPE = { projectId: 'project-1', worktreeId: 'wt-1' };
const SRC = { repoId: 'project-1', relativePath: 'src/index.ts' };
const DEST = { repoId: 'project-1', relativePath: 'docs/index.ts' };

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let mutations: FileTreeMutationRequest[];
let locked: Set<string>;
let refusal: Error | null;

function recordingHost(): AdvisorFileTreeActionHost {
  return {
    isSplitLocked: (projectId, worktreeId) =>
      locked.has(`${projectId}/${worktreeId}`),
    mutate: (request) => {
      mutations.push(request);
      if (refusal) return Promise.reject(refusal);
      return Promise.resolve({
        operation: request.operation,
        ...('source' in request && { source: request.source }),
        target: request.target,
      });
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6006-file-tree-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  mutations = [];
  locked = new Set();
  refusal = null;
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor file tree actions in main (CAN-6006)', () => {
  it('the five mutations are core file-tree writes with only worker.filesystem.write; file.save_active is presentation', () => {
    for (const type of ADVISOR_FILE_TREE_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'file-tree',
        grants: ['worker.filesystem.write'],
        revision: 'none',
      });
    expect(appAdvisorActionDisposition('file.save_active')).toEqual({
      kind: 'presentation',
    });
  });

  it("sends the window's requests: delete to the Trash, move refusing an occupied destination, copy with the asked conflict", async () => {
    const h = setup();
    const inputs = [
      { type: 'file-tree.create_file', ...SCOPE, target: DEST },
      { type: 'file-tree.create_directory', ...SCOPE, target: DEST },
      { type: 'file-tree.copy', ...SCOPE, source: SRC, target: DEST },
      {
        type: 'file-tree.copy',
        ...SCOPE,
        source: SRC,
        target: DEST,
        conflict: 'increment',
      },
      { type: 'file-tree.move', ...SCOPE, source: SRC, target: DEST },
      { type: 'file-tree.delete', ...SCOPE, target: SRC },
    ];
    const results = [];
    for (const [index, input] of inputs.entries())
      results.push(await h.route(input, { toolUseId: `t${index}` }));

    expect(mutations).toEqual([
      { operation: 'create-file', ...SCOPE, target: DEST },
      { operation: 'create-directory', ...SCOPE, target: DEST },
      {
        operation: 'copy',
        ...SCOPE,
        source: SRC,
        target: DEST,
        conflict: undefined,
      },
      {
        operation: 'copy',
        ...SCOPE,
        source: SRC,
        target: DEST,
        conflict: 'increment',
      },
      {
        operation: 'move',
        ...SCOPE,
        source: SRC,
        target: DEST,
        conflict: 'error',
      },
      { operation: 'delete', ...SCOPE, target: SRC, useTrash: true },
    ]);
    expect(results[4]).toMatchObject({
      ok: true,
      result: { operation: 'move', source: SRC, target: DEST },
    });
    expect(mockHostOptions).toEqual(
      inputs.map(() => ({ chatId: 'advisor-chat' })),
    );
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('refuses a split-locked worktree before any mutation', async () => {
    locked.add('project-1/wt-1');
    await expect(
      setup().route({ type: 'file-tree.delete', ...SCOPE, target: SRC }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
    expect(mutations).toEqual([]);
  });

  it("answers an owner's refusal with its message, as the window did", async () => {
    refusal = new Error('File is outside the selected worktree root.');
    await expect(
      setup().route({ type: 'file-tree.delete', ...SCOPE, target: SRC }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'File is outside the selected worktree root.',
      },
    });
  });

  it('a retried tool call acts once for each of the five', async () => {
    const h = setup();
    const inputs = [
      { type: 'file-tree.create_file', ...SCOPE, target: DEST },
      { type: 'file-tree.create_directory', ...SCOPE, target: DEST },
      { type: 'file-tree.copy', ...SCOPE, source: SRC, target: DEST },
      { type: 'file-tree.move', ...SCOPE, source: SRC, target: DEST },
      { type: 'file-tree.delete', ...SCOPE, target: SRC },
    ];
    for (const input of inputs) {
      const first = await h.route(input, { toolUseId: `retry-${input.type}` });
      const second = await h.route(input, {
        toolUseId: `retry-${input.type}`,
      });
      expect(second).toEqual(first);
      expect(first).toMatchObject({ ok: true });
    }
    expect(mutations.map((request) => request.operation)).toEqual([
      'create-file',
      'create-directory',
      'copy',
      'move',
      'delete',
    ]);
  });
});
