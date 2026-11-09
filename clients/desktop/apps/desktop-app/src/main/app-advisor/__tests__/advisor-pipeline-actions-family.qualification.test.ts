import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as SendOrchestrationModule from '../../agent-messaging/send-orchestration';
import type * as ChatTargetModule from '../../project-discovery/chat-target';
import type * as AdvisorChatActionsModule from '../advisor-chat-actions';
import type { AdvisorPipelineActionHost } from '../advisor-pipeline-actions';

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

const mockSends: unknown[] = [];
jest.mock('../../agent-messaging/send-orchestration', (): object => ({
  ...jest.requireActual<typeof SendOrchestrationModule>(
    '../../agent-messaging/send-orchestration',
  ),
  dispatchAgentChatSend: (action: unknown, options: unknown): object => {
    mockSends.push({ action, options });
    return Promise.resolve({ watcherReceipts: [] });
  },
}));

jest.mock('../../project-discovery/chat-target', (): object => ({
  ...jest.requireActual<typeof ChatTargetModule>(
    '../../project-discovery/chat-target',
  ),
  resolveAuthorizedChat: (target: {
    projectId: string;
    taskId: string;
    chatId: string;
  }): object =>
    Promise.resolve({
      address: target,
      row: { capabilities: { canSend: true } },
    }),
}));

const mockCreated: unknown[] = [];
jest.mock('../advisor-chat-actions', (): object => ({
  ...jest.requireActual<typeof AdvisorChatActionsModule>(
    '../advisor-chat-actions',
  ),
  dispatchAdvisorChatAction: (action: unknown): object => {
    mockCreated.push(action);
    return Promise.resolve({
      ok: true,
      result: { workEntryId: 'entry-debug', chatId: 'chat-debug' },
    });
  },
}));

let mockTabs: {
  activeTabId: string;
  tabs: Array<{ id: string; kind?: string }>;
} | null;
jest.mock('../advisor-chat-read-host', () => ({
  mainAdvisorChatReadHost: (): object => ({
    readTabs: (): Promise<unknown> => Promise.resolve(mockTabs),
  }),
}));

let mockOwners: Pick<
  AdvisorPipelineActionHost,
  'loadExecution' | 'readArtifact' | 'statFile' | 'rerun' | 'debugPrompt'
>;
jest.mock('../advisor-pipeline-actions-host', () => ({
  mainAdvisorPipelineActionHost: (
    options: Pick<
      AdvisorPipelineActionHost,
      'readTabs' | 'sendToChat' | 'revealChat' | 'createAdvisorChat'
    >,
  ): AdvisorPipelineActionHost => ({ ...mockOwners, ...options }),
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
import { ADVISOR_PIPELINE_ACTION_TYPES } from '../advisor-pipeline-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const REPORT = '/data/executions/exec-1/report.md';
const PLAN = '/repo/wt/plans/plan.md';

function execution(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    id: 'exec-1',
    pipeline_id: 'pipe',
    status: 'failure',
    project_id: 'proj',
    worktree_id: 'wt',
    cwd: '/repo/wt',
    pipeline_snapshot: { name: 'Nightly' },
    report_outputs: { report_file: REPORT },
    event_data: { plan_ready: { plan_path: PLAN } },
    plan_hash_before: 'a',
    plan_hash_after: 'b',
    ...overrides,
  } as ExecutionState;
}

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let executions: Record<string, ExecutionState>;

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
  root = mkdtempSync(join(tmpdir(), 'can-6001-pipeline-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  executions = { 'exec-1': execution() };
  mockTabs = {
    activeTabId: 'chat-active',
    tabs: [
      { id: 'chat-active' },
      { id: 'chat-2' },
      { id: 'file-1', kind: 'file' },
    ],
  };
  mockSends.length = 0;
  mockCreated.length = 0;
  mockRequestRendererTool.mockClear();
  mockOwners = {
    loadExecution: (executionId): Promise<ExecutionState | null> =>
      Promise.resolve(executions[executionId] ?? null),
    readArtifact: (
      state,
      artifact,
    ): Promise<{ filePath: string; content: string } | null> => {
      (calls.read ??= []).push(artifact);
      const filePath =
        artifact.kind === 'plan'
          ? state.event_data?.plan_ready?.plan_path
          : state.report_outputs?.report_file;
      // The containment check main applies: nothing outside its directories.
      return Promise.resolve(
        filePath === REPORT || filePath === PLAN
          ? { filePath, content: `content of ${filePath}` }
          : null,
      );
    },
    statFile: (): Promise<{ sizeBytes: number; modifiedAtMs: number }> =>
      Promise.resolve({ sizeBytes: 12, modifiedAtMs: 1000 }),
    rerun: (executionId): Promise<AppAdvisorJson> => {
      (calls.rerun ??= []).push(executionId);
      return Promise.resolve({ success: true, data: { id: 'exec-2' } });
    },
    debugPrompt: (executionId): Promise<string> => {
      (calls.debugPrompt ??= []).push(executionId);
      return Promise.resolve('The Nightly run failed at step build.');
    },
  };
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

function sentText(index = 0): string {
  const sent = mockSends[index] as { action: { text: string } } | undefined;
  return sent?.action.text ?? '';
}

describe('App Advisor pipeline actions in main (CAN-6001)', () => {
  it('six are core in main and pipeline.save is presentation', () => {
    expect(ADVISOR_PIPELINE_ACTION_TYPES).toHaveLength(6);
    expect(appAdvisorActionDisposition('pipeline.save')).toEqual({
      kind: 'presentation',
    });
    expect(
      appAdvisorActionDisposition('pipeline.execution_read_report'),
    ).toEqual({ kind: 'core', access: 'read', executor: 'pipeline-execution' });
    expect(appAdvisorActionDisposition('pipeline.execution_read_plan')).toEqual(
      { kind: 'core', access: 'read', executor: 'pipeline-execution' },
    );
    for (const [type, grants] of [
      ['pipeline.execution_start_over', ['core.pipeline.write']],
      ['pipeline.execution_send_report_to_chat', ['core.chat.write']],
      ['pipeline.execution_send_plan_to_chat', ['core.chat.write']],
      ['pipeline.debug_run', ['core.chat.write', 'core.worktree.write']],
    ] as const)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'pipeline-execution',
        grants,
        revision: 'none',
      });
  });

  it("reads the report and plan main resolves for the execution, in the renderer's shape", async () => {
    const report = await setup().route({
      type: 'pipeline.execution_read_report',
      executionId: 'exec-1',
      maxChars: 7,
    });
    const plan = await setup().route({
      type: 'pipeline.execution_read_plan',
      executionId: 'exec-1',
    });

    expect(report).toMatchObject({
      ok: true,
      result: {
        executionId: 'exec-1',
        kind: 'text',
        filePath: REPORT,
        content: 'content',
        truncated: true,
      },
    });
    expect(plan).toMatchObject({
      ok: true,
      result: {
        filePath: PLAN,
        filename: 'plan.md',
        sizeBytes: 12,
        modifiedAtMs: 1000,
        planModified: true,
        truncated: false,
      },
    });
    expect(calls.read).toEqual([
      { kind: 'report', format: 'text' },
      { kind: 'plan' },
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('an unknown execution reads, reruns, sends and debugs nothing', async () => {
    for (const type of ADVISOR_PIPELINE_ACTION_TYPES)
      await expect(
        setup().route({ type, executionId: 'missing' }, { toolUseId: type }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls.rerun).toBeUndefined();
    expect(mockSends).toEqual([]);
    expect(mockCreated).toEqual([]);
  });

  it("sends the advisor's prompt with only the report path main read, to the worktree's stored active chat", async () => {
    const result = await setup().route({
      type: 'pipeline.execution_send_report_to_chat',
      executionId: 'exec-1',
      prompt: 'Summarise the failures.',
      path: '/etc/forged-report.md',
      content: 'forged body',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-active',
        path: REPORT,
      },
    });
    expect(sentText()).toBe(
      `Summarise the failures.\n\nReview this report: ${REPORT}`,
    );
    expect(sentText()).not.toContain('forged');
    expect(mockSends[0]).toMatchObject({
      action: {
        type: 'projects.send_message',
        projectId: 'proj',
        taskId: 'wt',
        chatId: 'chat-active',
      },
    });
  });

  it('a plan send with no prompt names the plan main read, in the named chat', async () => {
    await setup().route({
      type: 'pipeline.execution_send_plan_to_chat',
      executionId: 'exec-1',
      chatId: 'chat-2',
    });

    expect(sentText()).toBe(`Review this plan: ${PLAN}`);
    expect(mockSends[0]).toMatchObject({ action: { chatId: 'chat-2' } });
  });

  it("a report outside the execution's directory is refused and nothing is sent", async () => {
    executions['exec-1'] = execution({
      report_outputs: { report_file: '/etc/passwd' },
      event_data: { plan_ready: { plan_path: '/home/someone/plan.md' } },
    });

    for (const type of [
      'pipeline.execution_send_report_to_chat',
      'pipeline.execution_send_plan_to_chat',
      'pipeline.execution_read_report',
      'pipeline.execution_read_plan',
    ])
      await expect(
        setup().route({ type, executionId: 'exec-1' }, { toolUseId: type }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(mockSends).toEqual([]);
  });

  it('a send refuses a file tab, an unknown chat and an execution with no worktree', async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'pipeline.execution_send_report_to_chat',
          executionId: 'exec-1',
          chatId: 'file-1',
        },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    await expect(
      h.route(
        {
          type: 'pipeline.execution_send_report_to_chat',
          executionId: 'exec-1',
          chatId: 'other-chat',
        },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    executions['exec-1'] = execution({ project_id: undefined });
    await expect(
      h.route(
        {
          type: 'pipeline.execution_send_report_to_chat',
          executionId: 'exec-1',
        },
        { toolUseId: 'c' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(mockSends).toEqual([]);
  });

  it('start over reruns only the execution main resolved', async () => {
    const result = await setup().route({
      type: 'pipeline.execution_start_over',
      executionId: 'exec-1',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { success: true, data: { id: 'exec-2' } },
    });
    expect(calls.rerun).toEqual(['exec-1']);
  });

  it('a refused rerun answers a failure, so a retry is not a recorded success', async () => {
    mockOwners.rerun = (executionId): Promise<AppAdvisorJson> => {
      (calls.rerun ??= []).push(executionId);
      return Promise.resolve({
        success: false,
        error: 'Execution is already being rerun',
      });
    };
    await expect(
      setup().route({
        type: 'pipeline.execution_start_over',
        executionId: 'exec-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Execution is already being rerun',
      },
    });
  });

  it('a debug run creates an App Advisor chat from the resolved execution only', async () => {
    const result = await setup().route({
      type: 'pipeline.debug_run',
      executionId: 'exec-1',
      projectId: 'other-project',
      worktreeId: 'other-worktree',
      title: 'Forged title',
      text: 'Forged prompt',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { chatId: 'chat-debug', workEntryId: 'entry-debug' },
    });
    expect(mockCreated).toEqual([
      {
        type: 'advisor-chat.create_entry',
        title: 'Debug Nightly',
        text: 'The Nightly run failed at step build.',
      },
    ]);
    expect(calls.debugPrompt).toEqual(['exec-1']);
  });

  it('a debug run refuses an execution that did not fail', async () => {
    executions['exec-1'] = execution({ status: 'success' });
    await expect(
      setup().route({ type: 'pipeline.debug_run', executionId: 'exec-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(mockCreated).toEqual([]);
  });

  it('a retried send, debug run or start over acts once', async () => {
    const h = setup();
    for (const input of [
      { type: 'pipeline.execution_send_report_to_chat', executionId: 'exec-1' },
      { type: 'pipeline.debug_run', executionId: 'exec-1' },
      { type: 'pipeline.execution_start_over', executionId: 'exec-1' },
    ]) {
      const first = await h.route(input, { toolUseId: `retry-${input.type}` });
      const second = await h.route(input, { toolUseId: `retry-${input.type}` });
      expect(second).toEqual(first);
    }

    expect(mockSends).toHaveLength(1);
    expect(mockCreated).toHaveLength(1);
    expect(calls.rerun).toEqual(['exec-1']);
  });
});
