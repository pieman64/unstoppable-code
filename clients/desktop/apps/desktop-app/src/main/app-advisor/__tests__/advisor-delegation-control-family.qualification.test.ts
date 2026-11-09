import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorDelegationControlHost } from '../advisor-delegation-control';

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

let mockHost: AdvisorDelegationControlHost;
jest.mock('../advisor-delegation-control-host', () => ({
  mainAdvisorDelegationControlHost: (): AdvisorDelegationControlHost =>
    mockHost,
}));

const mockReadChanges = jest.fn();
jest.mock('../../agents/delegation/service', () => ({
  readManagedDelegationChangesForUser: (...args: unknown[]): unknown =>
    mockReadChanges(...args),
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  APP_ADVISOR_ACTION_DISPOSITIONS,
  APP_ADVISOR_ACTION_GRANTS,
  appAdvisorActionDisposition,
} from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  joinStopAll,
  stopAllUnderFence,
} from '../../agents/delegation/user-stop-all';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { cancelSubagentRun } from '../advisor-delegation-control';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };
const REVISION = 'a'.repeat(40);
const parent: DelegationParentContext = {
  harnessId: 'harness',
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat-1',
  sessionKey: 'session',
  turnId: 'turn',
  toolCallId: 'tool',
  runtimeGeneration: 1,
  depth: 0,
};

function snapshot(
  delegationId: string,
  overrides: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot {
  return {
    delegationId,
    status: 'running',
    runGeneration: 1,
    ...overrides,
  } as AgentDelegationSnapshot;
}

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
/** The named chat's delegations, as its broker reports them. */
let chatDelegations: AgentDelegationSnapshot[];
/** Live core runs by `${delegationId}:${runGeneration}`. */
let liveRuns: Record<string, string>;
/** The operations the ledger records as core.agent.subagent.run. */
let subagentRuns: Set<string>;
let cancelFails: boolean;

function recordingHost(): AdvisorDelegationControlHost {
  return {
    inspect: (target, delegationId) =>
      Promise.resolve(
        target.chatId === 'no-delegations'
          ? {
              ok: false,
              error: {
                code: 'parent_unavailable',
                message: 'This chat has no delegations to stop.',
                retryable: false,
              },
            }
          : {
              ok: true,
              value:
                chatDelegations.find((s) => s.delegationId === delegationId) ??
                null,
            },
      ),
    findLiveRun: (delegationId, runGeneration) =>
      liveRuns[`${delegationId}:${runGeneration}`] ?? null,
    isSubagentRun: (operationId) =>
      Promise.resolve(subagentRuns.has(operationId)),
    cancelOperation: (operationId) => {
      (calls.cancel ??= []).push(operationId);
      return cancelFails
        ? Promise.reject(new Error('refused'))
        : Promise.resolve();
    },
    stopWithoutRun: (target, delegationId) => {
      (calls.brokerStop ??= []).push(delegationId);
      return Promise.resolve({ ok: true, value: undefined });
    },
    stopAll: (target, stopRoot) =>
      joinStopAll(
        `${target.projectId}:${target.worktreeId}:${target.chatId}`,
        () =>
          stopAllUnderFence({
            broker: {
              list: () => chatDelegations,
              stop: (_parent, id) => {
                (calls.brokerStop ??= []).push(id);
                chatDelegations = chatDelegations.map((s) =>
                  s.delegationId === id ? { ...s, status: 'cancelled' } : s,
                );
                return Promise.resolve({ ok: true, value: snapshot(id) });
              },
              activeCount: () => 0,
              queuedCount: () => 0,
            },
            parent,
            chat: {
              holdStopAllFence: () => () => undefined,
              fenceNotices: () => Promise.resolve(),
              nextActivity: () => Promise.resolve(),
              retireWatchers: () => Promise.resolve(),
            },
            stopRoot: async (top, brokerStop) => {
              const result = await stopRoot(top, brokerStop);
              // A cancelled run ends its delegation through the broker's bound stop.
              if (result.ok)
                chatDelegations = chatDelegations.map((s) =>
                  s.delegationId === top.delegationId
                    ? { ...s, status: 'cancelled' }
                    : s,
                );
              return result;
            },
          }),
      ),
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
  root = mkdtempSync(join(tmpdir(), 'can-6000-delegation-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  chatDelegations = [
    snapshot('del-live', { runGeneration: 2 }),
    snapshot('del-queued', { status: 'pending', runGeneration: undefined }),
  ];
  liveRuns = { 'del-live:2': 'op-subagent' };
  subagentRuns = new Set(['op-subagent']);
  cancelFails = false;
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
  mockReadChanges.mockReset();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor delegation actions in main (CAN-6000)', () => {
  it('stop and stop_all are core writes with only core.operation.cancel; read_changes is a delegation read', () => {
    for (const type of ['delegation.stop', 'delegation.stop_all'])
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'delegation-control',
        grants: ['core.operation.cancel'],
        revision: 'none',
      });
    expect(appAdvisorActionDisposition('delegation.read_changes')).toEqual({
      kind: 'core',
      access: 'read',
      executor: 'delegation-read',
    });
    expect(APP_ADVISOR_ACTION_GRANTS).toContain('core.operation.cancel');
    expect(
      Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS)
        .filter(
          ([, d]) =>
            'grants' in d && d.grants.includes('core.operation.cancel'),
        )
        .map(([type]) => type)
        .sort(),
    ).toEqual(['delegation.stop', 'delegation.stop_all']);
  });

  it('a delegate with a live run is stopped by core.operation.cancel on its core.agent.subagent.run', async () => {
    const result = await setup().route({
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'del-live',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { delegationId: 'del-live', status: 'stopping' },
    });
    expect(calls.cancel).toEqual(['op-subagent']);
    expect(calls.brokerStop).toBeUndefined();
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('a delegate with no live run is stopped through the broker user stop', async () => {
    const result = await setup().route({
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'del-queued',
    });

    expect(result).toMatchObject({ ok: true });
    expect(calls.brokerStop).toEqual(['del-queued']);
    expect(calls.cancel).toBeUndefined();
  });

  it('an unknown delegation, or one in another chat, cancels nothing', async () => {
    const unknown = await setup().route({
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'other-chat-delegation',
    });
    const noDelegations = await setup().route(
      {
        type: 'delegation.stop',
        ...TARGET,
        chatId: 'no-delegations',
        delegationId: 'del-live',
      },
      { toolUseId: 'toolu_2' },
    );

    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(noDelegations).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(calls.cancel).toBeUndefined();
    expect(calls.brokerStop).toBeUndefined();
  });

  it('a resolved operation that is not a core.agent.subagent.run is refused, even one main resolved', async () => {
    chatDelegations.push(snapshot('del-pipeline'));
    liveRuns['del-pipeline:1'] = 'op-pipeline-execution';

    const result = await setup().route({
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'del-pipeline',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(calls.cancel).toBeUndefined();
    expect(calls.brokerStop).toBeUndefined();
    for (const operationId of ['op-pipeline-execution', 'op-chat-turn'])
      await expect(
        cancelSubagentRun(operationId, mockHost),
      ).resolves.toMatchObject({ ok: false });
    expect(calls.cancel).toBeUndefined();
  });

  it('a cancel core refuses answers a retryable failure', async () => {
    cancelFails = true;
    const result = await setup().route({
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'del-live',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', retryable: true },
    });
  });

  it('stop_all cancels each live run and stops a queued delegate through the broker, under the fence', async () => {
    const result = await setup().route({
      type: 'delegation.stop_all',
      ...TARGET,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { stopped: 2, delegationIds: ['del-live', 'del-queued'] },
    });
    expect(calls.cancel).toEqual(['op-subagent']);
    expect(calls.brokerStop).toEqual(['del-queued']);
  });

  it('stop_all refuses a live root whose operation is not a subagent run, and cancels nothing', async () => {
    subagentRuns.clear();
    const result = await setup().route({
      type: 'delegation.stop_all',
      ...TARGET,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(calls.cancel).toBeUndefined();
  });

  it('a second stop_all during the first changes nothing and reports the same set', async () => {
    const h = setup();
    const [first, second] = await Promise.all([
      h.route(
        { type: 'delegation.stop_all', ...TARGET },
        { toolUseId: 'toolu_a' },
      ),
      h.route(
        { type: 'delegation.stop_all', ...TARGET },
        { toolUseId: 'toolu_b' },
      ),
    ]);

    expect(second.ok).toBe(true);
    expect(second).toMatchObject({ result: first.ok ? first.result : {} });
    expect(calls.cancel).toEqual(['op-subagent']);
    expect(calls.brokerStop).toEqual(['del-queued']);
  });

  it('a stop runs once per tool call', async () => {
    const h = setup();
    const input = {
      type: 'delegation.stop',
      ...TARGET,
      delegationId: 'del-live',
    };
    const first = await h.route(input, { toolUseId: 'toolu_9' });
    const second = await h.route(input, { toolUseId: 'toolu_9' });

    expect(second).toEqual(first);
    expect(calls.cancel).toEqual(['op-subagent']);
  });

  it("read_changes reads the delegate's changes from its starting revision in main", async () => {
    mockReadChanges.mockResolvedValue({
      files: [
        { path: 'a.ts', change: 'modified', diff: '@@', diffTruncated: true },
        { path: 'b.ts', change: 'added' },
      ],
      omittedFiles: 3,
    });

    const result = await setup().route({
      type: 'delegation.read_changes',
      projectId: 'proj',
      worktreeId: 'wt',
      delegationId: 'del-live',
      revision: REVISION,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        files: [
          { path: 'a.ts', change: 'modified', diff: '@@', diffTruncated: true },
          { path: 'b.ts', change: 'added' },
        ],
        omittedFiles: 3,
      },
    });
    expect(mockReadChanges).toHaveBeenCalledWith(
      { projectId: 'proj', worktreeId: 'wt' },
      'del-live',
      REVISION,
      expect.any(AbortSignal),
    );
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it("read_changes answers the renderer's failure when the read fails", async () => {
    mockReadChanges.mockRejectedValue(new Error('not this revision'));
    const result = await setup().route({
      type: 'delegation.read_changes',
      projectId: 'proj',
      worktreeId: 'wt',
      delegationId: 'del-live',
      revision: REVISION,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't read the delegate's changes.",
      },
    });
  });
});
