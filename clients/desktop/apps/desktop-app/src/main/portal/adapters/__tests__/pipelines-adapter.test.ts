jest.mock('../../../pipelines/curated-pipeline-catalog', () => ({
  importCuratedPipeline: jest.fn(),
}));
import { importCuratedPipeline } from '../../../pipelines/curated-pipeline-catalog';
import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import {
  handlePortalPipelineCancel,
  handlePortalPipelineChatFollowUpPrepare,
  handlePortalPipelineContentRead,
  handlePortalPipelineExecutionList,
  handlePortalPipelineGet,
  handlePortalPipelineInstallCurated,
  handlePortalPipelineList,
  handlePortalPipelineLogRequest,
  handlePortalPipelineRerun,
  handlePortalPipelineResume,
  handlePortalPipelineRetry,
  handlePortalPipelineRun,
} from '../pipelines-adapter';
import type { PortalAdapterContext } from '../types';
import {
  cancelPipeline,
  getPipeline,
  getPipelineLog,
  listPipelineExecutions,
  listPipelines,
  preparePipelineChatFollowUp,
  readPipelineContent,
  rerunPipeline,
  resumePipeline,
  retryPipeline,
  runPipeline,
} from '../../../services/pipelines-service';
import { queryPortalChatState } from '../chat-state-query';
import { PortalServiceError } from '../../../services/portal-service-error';
import { PORTAL_CATALOG_RESULT_MAX_BYTES } from '@canopy/protocol/portal';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { portalFileReferences } from '../../portal-file-references';

const mockNotifyDesktopInventoryChanged = jest.fn();
jest.mock('../../../services/desktop-inventory-sync-signals', () => ({
  notifyDesktopInventoryChanged: (...args: unknown[]): unknown =>
    mockNotifyDesktopInventoryChanged(...args),
}));

jest.mock('../../../services/pipelines-service', () => ({
  cancelPipeline: jest.fn(),
  getPipelineExecution: jest.fn(),
  getPipeline: jest.fn(),
  getPipelineLog: jest.fn(),
  listPipelineExecutions: jest.fn(),
  listPipelines: jest.fn(),
  preparePipelineChatFollowUp: jest.fn(),
  readPipelineContent: jest.fn(),
  rerunPipeline: jest.fn(),
  resumePipeline: jest.fn(),
  retryPipeline: jest.fn(),
  runPipeline: jest.fn(),
}));

jest.mock('../chat-state-query', () => ({
  queryPortalChatState: jest.fn(),
}));

const mockGetTerminalState = jest.fn<
  { turnState: string } | undefined,
  [string, string, string]
>();
jest.mock('../../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): object => ({
    getState: mockGetTerminalState,
  }),
}));

const mockedRunPipeline = jest.mocked(runPipeline);
const mockedCancelPipeline = jest.mocked(cancelPipeline);
const mockedGetPipeline = jest.mocked(getPipeline);
const mockedListPipelines = jest.mocked(listPipelines);
const mockedGetPipelineLog = jest.mocked(getPipelineLog);
const mockedListPipelineExecutions = jest.mocked(listPipelineExecutions);
const mockedResumePipeline = jest.mocked(resumePipeline);
const mockedRetryPipeline = jest.mocked(retryPipeline);
const mockedRerunPipeline = jest.mocked(rerunPipeline);

function command<TPayload>(
  type: PortalCommandEnvelope['type'],
  payload: TPayload,
  target?: PortalCommandEnvelope['target'],
): PortalCommandEnvelope<TPayload> {
  return {
    id: 'cmd-1',
    sequence: 7,
    type,
    target,
    payload,
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
  };
}

function adapterContext(events: PortalEventEnvelope[]): PortalAdapterContext {
  return {
    getWindow: () => null,
    enqueueEvent: (event) => events.push(event),
    complete: (cmd, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: cmd.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (cmd, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: cmd.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

const run = {
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  localId: 'exec-1',
  pipelineId: 'pipe-1',
  status: 'running',
  jobs: [
    {
      jobId: 'job-1',
      name: 'Build',
      status: 'running',
      steps: [{ stepId: 'step-1', name: 'Test', status: 'running' }],
    },
  ],
};

describe('pipelines portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    portalFileReferences.clear();
  });

  afterEach(() => portalFileReferences.clear());

  it('completes pipeline.get with the portal-safe read view model', async () => {
    const events: PortalEventEnvelope[] = [];
    const result = {
      definition: {
        name: 'CI',
        triggerSummary: 'Manual',
        scopes: ['worktree' as const],
        jobs: [
          {
            id: 'build',
            name: 'Build',
            dependencies: [],
            steps: [
              {
                id: 'checkout',
                name: 'Checkout',
                kind: 'action' as const,
                usesSummary: 'actions/checkout@v4',
              },
            ],
          },
        ],
      },
    };
    mockedGetPipeline.mockResolvedValue(result);

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
      }),
      adapterContext(events),
    );

    expect(mockedGetPipeline).toHaveBeenCalledWith({
      projectId: 'ws-1',
      pipelineId: 'project--ci.yml',
    });
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result },
    });
  });

  it('wraps pipeline.list summaries for the browser small-RPC feed', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListPipelines.mockResolvedValue([
      {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        pipelineId: 'pipe-1',
        name: 'CI',
      },
    ]);
    await handlePortalPipelineList(
      command('portal.pipeline.list', {
        projectId: 'ws-1',
      }),
      adapterContext(events),
    );
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { pipelines: [{ pipelineId: 'pipe-1' }] } },
    });
    expect(mockNotifyDesktopInventoryChanged).toHaveBeenCalledWith([
      'pipelines',
    ]);
  });

  it('prefix-caps oversized pipeline lists at the small-RPC result budget', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListPipelines.mockResolvedValue(
      Array.from({ length: 2_000 }, (_, index) => ({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        pipelineId: `pipeline-${index}`,
        name: `${String(index).padStart(4, '0')}-${'x'.repeat(500)}`,
      })),
    );

    await handlePortalPipelineList(
      command('portal.pipeline.list', { projectId: 'ws-1' }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toHaveProperty('payload.result.truncated', true);
    expect(events[0]).toHaveProperty(
      'payload.result.pipelines.0.pipelineId',
      'pipeline-0',
    );
    expect(JSON.stringify(events[0])).not.toContain('pipeline-1999');
  });

  it('prefix-caps oversized pipeline rows at the small-RPC result budget', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: Array.from({ length: 10_000 }, (_, index) => ({
          id: `job-${index}`,
          name: `Job ${index} ${'x'.repeat(100)}`,
          dependencies: [],
          steps: [],
        })),
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
      }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      payload: {
        result: { truncated: true },
      },
    });
    expect(events[0]).not.toHaveProperty(
      'payload.result.definition.canonicalYaml',
    );
    expect(events[0]).not.toHaveProperty(
      'payload.result.definition.canonicalYamlTruncated',
    );
  });

  it('keeps the hydrated plan_ready inputs when the definition is prefix-cut', async () => {
    // The portal plan picker hydrates a shared/cloud pipeline's trigger inputs
    // from THIS result (CAN-3021) — the synced list row carries none. Cutting
    // the definition to fit the budget must not take the inputs with it, or a
    // large shared pipeline dispatches with every declared input missing and
    // no field ever rendered.
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: Array.from({ length: 10_000 }, (_, index) => ({
          id: `job-${index}`,
          name: `Job ${index} ${'x'.repeat(100)}`,
          dependencies: [],
          steps: [],
        })),
      },
      planReadyInputs: {
        max_iterations: { type: 'number', description: 'Max iterations' },
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'shared:canopy-cloud:abc123',
      }),
      adapterContext(events),
    );

    // The budget is measured on the RESULT (see `resultByteLength`), and the
    // inputs are counted against it while the row limit is searched — so
    // carrying them through can never push a fitted result over.
    const result = (events[0].payload as { result: unknown }).result;
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      payload: {
        result: {
          truncated: true,
          planReadyInputs: {
            max_iterations: { type: 'number', description: 'Max iterations' },
          },
        },
      },
    });
  });

  it('degrades to capped metadata when a single field exceeds the budget', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        description: 'd'.repeat(800 * 1024),
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
      }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: {
        result: {
          truncated: true,
          definition: { name: 'CI', triggerSummary: 'Manual', jobs: [] },
        },
      },
    });
    expect(events[0]).not.toHaveProperty(
      'payload.result.definition.description',
    );
  });

  it('keeps the plan_ready inputs through the last-resort metadata fallback', async () => {
    // The fallback returns a NON-error result, and the plan picker treats any
    // result without an `error` as authoritative — so dropping the inputs here
    // hydrates the row to "no inputs" and arms Run for a pipeline that actually
    // declares required ones. They are small; carry them whenever they fit.
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        description: 'd'.repeat(800 * 1024),
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
      planReadyInputs: {
        environment: { type: 'string', required: true, description: 'Env' },
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'shared:canopy-cloud:abc123',
      }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      payload: {
        result: {
          truncated: true,
          definition: { name: 'CI', jobs: [] },
          planReadyInputs: {
            environment: { type: 'string', required: true, description: 'Env' },
          },
        },
      },
    });
  });

  it('marks the inputs as omitted when even the fallback cannot carry them', async () => {
    // Both the metadata and the inputs are oversized, so there is nothing left
    // to cut. The result must SAY the inputs were dropped: absent-because-cut
    // and absent-because-none-declared are otherwise the same wire shape, and
    // the picker would arm Run for a pipeline with required inputs.
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        description: 'd'.repeat(800 * 1024),
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
      planReadyInputs: {
        environment: {
          type: 'string',
          required: true,
          description: 'E'.repeat(800 * 1024),
        },
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'shared:canopy-cloud:abc123',
      }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      payload: {
        result: {
          truncated: true,
          planReadyInputsOmitted: true,
        },
      },
    });
    // And the cut inputs are genuinely gone, not merely flagged.
    expect(events[0]).not.toHaveProperty('payload.result.planReadyInputs');
  });

  it('carries dispatch inputs through a row cut (CAN-3174)', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [
          {
            id: 'job',
            name: 'Job',
            dependencies: [],
            steps: Array.from({ length: 4000 }, (_, index) => ({
              id: `step-${String(index)}`,
              name: 'S'.repeat(200),
              kind: 'action' as const,
              usesSummary: '',
            })),
          },
        ],
      },
      dispatchInputs: { environment: { type: 'string', required: true } },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'pipe-1',
      }),
      adapterContext(events),
    );

    expect(events[0]).toMatchObject({
      payload: {
        result: {
          truncated: true,
          dispatchInputs: { environment: { type: 'string', required: true } },
        },
      },
    });
  });

  it('marks dispatch inputs omitted when even the fallback cannot carry them (CAN-3174)', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        description: 'd'.repeat(800 * 1024),
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
      dispatchInputs: {
        environment: {
          type: 'string',
          required: true,
          description: 'E'.repeat(800 * 1024),
        },
      },
      dispatchUnsupportedReason: 'json_input',
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'pipe-1',
      }),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toMatchObject({
      payload: {
        result: {
          truncated: true,
          dispatchInputsOmitted: true,
          dispatchUnsupportedReason: 'json_input',
        },
      },
    });
    expect(events[0]).not.toHaveProperty('payload.result.dispatchInputs');
  });

  it('does not mark inputs omitted for a pipeline that declares none', async () => {
    // The marker must mean "cut", not "truncated". A pipeline with no inputs
    // that gets its rows cut stays hydratable.
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockResolvedValue({
      definition: {
        name: 'CI',
        description: 'd'.repeat(800 * 1024),
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
    });

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        pipelineId: 'shared:canopy-cloud:abc123',
      }),
      adapterContext(events),
    );

    expect(events[0]).toMatchObject({
      payload: { result: { truncated: true } },
    });
    expect(events[0]).not.toHaveProperty(
      'payload.result.planReadyInputsOmitted',
    );
  });

  it.each([
    ['missing locator', { pipelineId: 'project--ci.yml' }],
    ['malformed payload', 'project--ci.yml'],
  ])('rejects pipeline.get with a %s', async (_label, payload) => {
    const events: PortalEventEnvelope[] = [];

    await Reflect.apply(handlePortalPipelineGet, undefined, [
      command('portal.pipeline.get', payload),
      adapterContext(events),
    ]);

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('fails closed when pipeline.get cannot find the locator', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipeline.mockRejectedValueOnce(
      new PortalServiceError('not_found', 'Pipeline not found.'),
    );

    await handlePortalPipelineGet(
      command('portal.pipeline.get', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'project--missing.yml',
      }),
      adapterContext(events),
    );

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'not_found', message: 'Pipeline not found.' } },
    });
  });

  it('passes command correlation to the pipeline run service before completion', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRunPipeline.mockResolvedValue({ executionId: 'exec-1' });

    await handlePortalPipelineRun(
      command(
        'portal.pipeline.run',
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pipelineId: 'pipe-1',
        },
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        },
      ),
      adapterContext(events),
    );

    expect(mockedRunPipeline).toHaveBeenCalledWith(expect.any(Object), {
      portalCommandId: 'cmd-1',
    });
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
  });

  it('resolves opaque task-ready mentions only on the paired host before launching a pipeline', async () => {
    const events: PortalEventEnvelope[] = [];
    const fileReference = portalFileReferences.mint(
      { sessionId: 'session', projectId: 'ws-1', worktreeId: 'wt-1' },
      {
        absolutePath: '/destination/src/file.ts',
        displayPath: 'src/file.ts',
        textStart: 7,
      },
    );
    mockedRunPipeline.mockResolvedValue({ executionId: 'exec-1' });
    const context = {
      ...adapterContext(events),
      sessionId: 'session',
      canReadAssets: (): boolean => true,
    };
    await handlePortalPipelineRun(
      command(
        'portal.pipeline.run',
        {
          pipelineId: 'pipe-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          eventName: 'task_ready',
          eventData: { task_ready: { task_text: 'Review src/file.ts' } },
          fileReferences: [fileReference],
        },
        { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      ),
      context,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        eventData: {
          task_ready: { task_text: 'Review /destination/src/file.ts' },
        },
      }),
      { portalCommandId: 'cmd-1' },
    );
    expect(JSON.stringify(events)).not.toContain('/destination');
    expect(JSON.stringify(mockedRunPipeline.mock.calls)).not.toContain(
      fileReference.referenceId,
    );
  });

  it.each([
    'expired',
    'wrong-session',
    'wrong-worktree',
    'revoked',
    'missing-permission',
  ] as const)(
    'rejects %s pipeline mentions without launching or leaking paths',
    async (failure) => {
      const events: PortalEventEnvelope[] = [];
      const fileReference = portalFileReferences.mint(
        { sessionId: 'session', projectId: 'ws-1', worktreeId: 'wt-1' },
        {
          absolutePath: '/private/secret.ts',
          displayPath: 'secret.ts',
          textStart: 7,
        },
      );
      if (failure === 'expired')
        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60 * 1000);
      const context: PortalAdapterContext = {
        ...adapterContext(events),
        sessionId: failure === 'wrong-session' ? 'other' : 'session',
        ...(failure === 'missing-permission'
          ? {}
          : { canReadAssets: (): boolean => failure !== 'revoked' }),
      };
      const worktreeId = failure === 'wrong-worktree' ? 'other' : 'wt-1';
      await handlePortalPipelineRun(
        command(
          'portal.pipeline.run',
          {
            pipelineId: 'pipe-1',
            projectId: 'ws-1',
            worktreeId,
            eventName: 'task_ready',
            eventData: { task_ready: { task_text: 'Review secret.ts' } },
            fileReferences: [fileReference],
          },
          { workspaceLocalId: 'ws-1', worktreeLocalId: worktreeId },
        ),
        context,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockedRunPipeline).not.toHaveBeenCalled();
      expect(events).toMatchObject([
        {
          type: 'portal.command.failed',
          payload: { error: { code: 'invalid_target' } },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('/private');
      jest.restoreAllMocks();
    },
  );

  it('rejects mismatched targets and malformed or unrepresented pipeline references', async () => {
    const contextEvents: PortalEventEnvelope[] = [];
    const reference = portalFileReferences.mint(
      { sessionId: 'session', projectId: 'ws-1', worktreeId: 'wt-1' },
      {
        absolutePath: '/private/file.ts',
        displayPath: 'file.ts',
        textStart: 7,
      },
    );
    const context = {
      ...adapterContext(contextEvents),
      sessionId: 'session',
      canReadAssets: (): boolean => true,
    };
    for (const input of [
      {
        target: { workspaceLocalId: 'other', worktreeLocalId: 'wt-1' },
        reference,
        text: 'Review file.ts',
      },
      {
        target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        reference: { ...reference, absolutePath: '/forged' },
        text: 'Review file.ts',
      },
      {
        target: { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        reference,
        text: 'Different task',
      },
    ]) {
      await handlePortalPipelineRun(
        command(
          'portal.pipeline.run',
          {
            pipelineId: 'pipe-1',
            projectId: 'ws-1',
            worktreeId: 'wt-1',
            eventName: 'task_ready',
            eventData: { task_ready: { task_text: input.text } },
            fileReferences: [input.reference],
          },
          input.target,
        ),
        context,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedRunPipeline).not.toHaveBeenCalled();
    expect(contextEvents.map((event) => event.type)).toEqual(
      Array(3).fill('portal.command.failed'),
    );
    expect(JSON.stringify(contextEvents)).not.toContain('/private');
  });

  it('keeps the command loop free while a pipeline run is still active', async () => {
    const events: PortalEventEnvelope[] = [];
    let finishRun: ((value: { executionId: string }) => void) | undefined;
    mockedRunPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
    );

    await handlePortalPipelineRun(
      command(
        'portal.pipeline.run',
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pipelineId: 'pipe-1',
        },
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        },
      ),
      adapterContext(events),
    );

    expect(mockedRunPipeline).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    finishRun?.({ executionId: 'exec-1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toMatchObject([
      { type: 'portal.command.completed', commandId: 'cmd-1' },
    ]);
  });

  it('keeps the command loop free while cancellation is still settling', async () => {
    const events: PortalEventEnvelope[] = [];
    const getWindow = jest.fn(() => null);
    let finishCancel: ((value: typeof run) => void) | undefined;
    mockedCancelPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    let handlerSettled = false;

    void handlePortalPipelineCancel(
      command(
        'portal.pipeline.cancel',
        { executionId: 'exec-1' },
        { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      ),
      { ...adapterContext(events), getWindow },
    ).then(() => {
      handlerSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(handlerSettled).toBe(true);
    expect(events).toEqual([]);
    expect(mockedCancelPipeline).toHaveBeenCalledWith(expect.any(Object), {
      portalCommandId: 'cmd-1',
      getWindow,
    });
    finishCancel?.(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toMatchObject([
      { type: 'portal.command.completed', commandId: 'cmd-1' },
    ]);
  });

  it('lists scoped pipeline executions through the small-RPC result', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListPipelineExecutions.mockResolvedValue({ runs: [run] });

    await handlePortalPipelineExecutionList(
      command(
        'portal.pipeline.execution_list',
        { limit: 10 },
        { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      ),
      adapterContext(events),
    );

    expect(mockedListPipelineExecutions).toHaveBeenCalledWith({
      limit: 10,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(events[0]).toMatchObject({
      type: 'portal.command.completed',
      payload: { result: { runs: [{ localId: 'exec-1' }] } },
    });
  });

  it('prefix-caps oversized execution lists at the small-RPC result budget', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedListPipelineExecutions.mockResolvedValue({
      runs: Array.from({ length: 2_000 }, (_, index) => ({
        ...run,
        localId: `exec-${index}`,
        outputTail: 'x'.repeat(1_000),
      })),
    });

    await handlePortalPipelineExecutionList(
      command(
        'portal.pipeline.execution_list',
        {},
        { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
      ),
      adapterContext(events),
    );

    expect(
      Buffer.byteLength(JSON.stringify(events[0]), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
    expect(events[0]).toHaveProperty('payload.result.truncated', true);
    expect(events[0]).toHaveProperty('payload.result.runs.0.localId', 'exec-0');
    expect(JSON.stringify(events[0])).not.toContain('exec-1999');
  });

  it.each([
    [
      'portal.pipeline.resume',
      handlePortalPipelineResume,
      mockedResumePipeline,
    ],
    ['portal.pipeline.retry', handlePortalPipelineRetry, mockedRetryPipeline],
    ['portal.pipeline.rerun', handlePortalPipelineRerun, mockedRerunPipeline],
  ] as const)(
    'passes target scope and correlation for %s',
    async (type, handler, service) => {
      const events: PortalEventEnvelope[] = [];
      service.mockResolvedValue(run);

      await handler(
        command(
          type,
          { executionId: 'exec-1' },
          { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        ),
        adapterContext(events),
      );

      expect(service).toHaveBeenCalledWith(
        {
          executionId: 'exec-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        },
        { portalCommandId: 'cmd-1' },
      );
      expect(events[0]).toMatchObject({
        type: 'portal.command.completed',
        payload: { result: { localId: 'exec-1' } },
      });
    },
  );

  it.each([
    [
      'portal.pipeline.execution_list',
      handlePortalPipelineExecutionList,
      mockedListPipelineExecutions,
      { projectId: 'ws-2', worktreeId: 'wt-2' },
    ],
    [
      'portal.pipeline.resume',
      handlePortalPipelineResume,
      mockedResumePipeline,
      {
        executionId: 'exec-1',
        projectId: 'ws-2',
        worktreeId: 'wt-2',
      },
    ],
    [
      'portal.pipeline.retry',
      handlePortalPipelineRetry,
      mockedRetryPipeline,
      {
        executionId: 'exec-1',
        projectId: 'ws-2',
        worktreeId: 'wt-2',
      },
    ],
    [
      'portal.pipeline.rerun',
      handlePortalPipelineRerun,
      mockedRerunPipeline,
      {
        executionId: 'exec-1',
        projectId: 'ws-2',
        worktreeId: 'wt-2',
      },
    ],
  ] as const)(
    'rejects payload scope that conflicts with the routed target for %s',
    async (type, handler, service, payload) => {
      const events: PortalEventEnvelope[] = [];

      await handler(
        command(type, payload, {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        }) as never,
        adapterContext(events),
      );

      expect(service).not.toHaveBeenCalled();
      expect(events).toMatchObject([
        {
          type: 'portal.command.failed',
          payload: { error: { code: 'invalid_target' } },
        },
      ]);
    },
  );

  it.each([
    [
      'portal.pipeline.resume',
      handlePortalPipelineResume,
      mockedResumePipeline,
    ],
    ['portal.pipeline.retry', handlePortalPipelineRetry, mockedRetryPipeline],
    ['portal.pipeline.rerun', handlePortalPipelineRerun, mockedRerunPipeline],
  ] as const)(
    'keeps the command loop free while %s is still starting',
    async (type, handler, service) => {
      const events: PortalEventEnvelope[] = [];
      let finish: ((value: typeof run) => void) | undefined;
      service.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );

      let returned = false;
      const handlerResult = handler(
        command(
          type,
          { executionId: 'exec-1' },
          { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' },
        ),
        adapterContext(events),
      );
      void handlerResult.then(() => {
        returned = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      const returnedBeforeService = returned;

      finish?.(run);
      await handlerResult;
      await Promise.resolve();
      await Promise.resolve();

      expect(returnedBeforeService).toBe(true);
      expect(events).toMatchObject([
        { type: 'portal.command.completed', commandId: 'cmd-1' },
      ]);
    },
  );

  it('passes command target scope to execution log requests', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipelineLog.mockResolvedValue({ lines: ['ok'] });

    await handlePortalPipelineLogRequest(
      command(
        'portal.pipeline.log_request',
        {
          executionId: 'exec-1',
          jobId: 'job-1',
          stepId: 'step-1',
        },
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        },
      ),
      adapterContext(events),
    );

    expect(mockedGetPipelineLog).toHaveBeenCalledWith(
      {
        executionId: 'exec-1',
        jobId: 'job-1',
        stepId: 'step-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-1' },
    );
  });

  it('log_request reconciles through the pipeline event without repeating lines', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedGetPipelineLog.mockResolvedValue({
      lines: ['ok'],
      run: {
        ...run,
        outputTail: 'ok',
        jobs: [
          {
            jobId: 'job-1',
            name: 'Build',
            status: 'running',
            steps: [
              {
                stepId: 'step-1',
                name: 'Test',
                status: 'success',
                outputTail: 'ok',
              },
            ],
          },
        ],
      },
    });

    await handlePortalPipelineLogRequest(
      command(
        'portal.pipeline.log_request',
        {
          executionId: 'exec-1',
          jobId: 'job-1',
          stepId: 'step-1',
        },
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        },
      ),
      adapterContext(events),
    );

    expect(mockedGetPipelineLog).toHaveBeenCalledWith(expect.any(Object), {
      portalCommandId: 'cmd-1',
    });
    expect(events.map((event) => event.type)).toEqual([
      'portal.command.completed',
    ]);
    expect(
      (events[0]?.payload as { result?: Record<string, unknown> } | undefined)
        ?.result,
    ).toEqual({});
  });
});

describe('curated pipeline portal import', () => {
  it('rejects malformed hashes before touching disk', async () => {
    const events: PortalEventEnvelope[] = [];
    await handlePortalPipelineInstallCurated(
      command('portal.pipeline.install_curated', {
        key: 'review',
        expectedContentHash: 'bad',
      }),
      adapterContext(events),
    );
    expect(events[0]?.type).toBe('portal.command.failed');
    expect(importCuratedPipeline).not.toHaveBeenCalled();
  });
  it('delegates the same reviewed hash to the desktop importer', async () => {
    const importedPipeline: PipelineInfo = {
      id: 'local-copy',
      name: 'Review',
      filename: 'review.yml',
      description: 'Review code',
      icon: '',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      source: 'user',
      readonly: false,
    };
    jest.mocked(importCuratedPipeline).mockResolvedValue(importedPipeline);
    const events: PortalEventEnvelope[] = [];
    await handlePortalPipelineInstallCurated(
      command('portal.pipeline.install_curated', {
        key: 'review',
        expectedContentHash: 'a'.repeat(64),
      }),
      adapterContext(events),
    );
    await Promise.resolve();
    expect(importCuratedPipeline).toHaveBeenCalledWith({
      key: 'review',
      expectedContentHash: 'a'.repeat(64),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result: { pipelineId: 'local-copy' } },
      }),
    );
  });
});

describe('pipeline chat follow-up preparation (CAN-3719)', () => {
  const mockedPrepare = jest.mocked(preparePipelineChatFollowUp);
  const mockedQueryChatState = jest.mocked(queryPortalChatState);
  const owner = { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' };

  function chatState(
    activeTabId: string,
    tabs: Array<{
      id: string;
      kind?: 'chat' | 'file';
      readOnly?: boolean;
      providerType?: 'claude' | 'codex';
      interfaceMode?: 'canopy' | 'claude-code' | 'auto';
      sdkSessionId?: string;
    }>,
  ): Awaited<ReturnType<typeof queryPortalChatState>> {
    return {
      schemaVersion: 1,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      revision: 1,
      tabsFile: {
        version: 1,
        activeTabId,
        tabs: tabs.map((tab) => ({
          ...tab,
          createdAt: '2026-10-24T00:00:00.000Z',
          title: tab.id,
          messages: [],
        })),
      },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };
  }

  function followUpContext(
    events: PortalEventEnvelope[],
  ): PortalAdapterContext {
    return { ...adapterContext(events), sessionId: 'session-1' };
  }

  async function prepare(
    payload: Record<string, unknown>,
    target: PortalCommandEnvelope['target'] = owner,
  ): Promise<PortalEventEnvelope[]> {
    const events: PortalEventEnvelope[] = [];
    await handlePortalPipelineChatFollowUpPrepare(
      command('portal.pipeline.chat_follow_up.prepare', payload, target),
      followUpContext(events),
    );
    await new Promise((resolve) => setImmediate(resolve));
    return events;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTerminalState.mockReset();
    mockedPrepare.mockResolvedValue({
      prompt: 'Review this report: /exec/report.md',
    });
  });

  it('returns the host prompt and the active writable chat of the run owner', async () => {
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-2', [{ id: 'chat-1' }, { id: 'chat-2' }]),
    );

    const events = await prepare({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'report',
    });

    expect(mockedPrepare).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'report',
    });
    expect(mockedQueryChatState).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: {
          result: {
            executionId: 'exec-1',
            projectId: 'ws-1',
            worktreeId: 'wt-1',
            output: 'report',
            prompt: 'Review this report: /exec/report.md',
            chatId: 'chat-2',
          },
        },
      }),
    ]);
  });

  it('skips a read-only active chat and file tabs for another writable chat', async () => {
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-ro', [
        { id: 'chat-ro', readOnly: true },
        { id: 'file-1', kind: 'file' },
        { id: 'chat-ok' },
      ]),
    );

    const events = await prepare({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'plan',
    });

    expect(events[0]?.payload).toMatchObject({
      result: { chatId: 'chat-ok', output: 'plan' },
    });
  });

  async function preparedChatId(): Promise<unknown> {
    const events = await prepare({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'report',
    });
    expect(events[0]?.type).toBe('portal.command.completed');
    const result = (
      events[0]?.payload as { result?: { chatId?: unknown } } | undefined
    )?.result;
    return result?.chatId;
  }

  it('skips an active terminal-backed chat for a native chat the portal can send to', async () => {
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-terminal', [
        {
          id: 'chat-terminal',
          providerType: 'claude',
          interfaceMode: 'claude-code',
          sdkSessionId: 'terminal-session',
        },
        { id: 'chat-native', providerType: 'claude' },
      ]),
    );

    await expect(preparedChatId()).resolves.toBe('chat-native');
  });

  it('returns no chat when every writable chat is driven by its terminal', async () => {
    mockGetTerminalState.mockImplementation((_project, _worktree, chatId) =>
      chatId === 'chat-running' ? { turnState: 'running' } : undefined,
    );
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-auto', [
        {
          id: 'chat-auto',
          providerType: 'claude',
          interfaceMode: 'auto',
          sdkSessionId: 'terminal-session',
        },
        { id: 'chat-running', providerType: 'claude' },
      ]),
    );

    await expect(preparedChatId()).resolves.toBeUndefined();
  });

  it('keeps a terminal-mode chat with no terminal session and non-Claude chats eligible', async () => {
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-fresh', [
        { id: 'chat-fresh', providerType: 'claude', interfaceMode: 'auto' },
      ]),
    );
    await expect(preparedChatId()).resolves.toBe('chat-fresh');

    mockedQueryChatState.mockResolvedValue(
      chatState('chat-codex', [
        {
          id: 'chat-codex',
          providerType: 'codex',
          interfaceMode: 'claude-code',
          sdkSessionId: 'codex-thread',
        },
      ]),
    );
    await expect(preparedChatId()).resolves.toBe('chat-codex');
  });

  it('returns no chat when the owner has no writable chat, so the client creates one', async () => {
    mockedQueryChatState.mockResolvedValue(
      chatState('chat-ro', [
        { id: 'chat-ro', readOnly: true },
        { id: 'file-1', kind: 'file' },
      ]),
    );

    const events = await prepare({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'plan',
    });

    expect(events[0]?.type).toBe('portal.command.completed');
    expect(events[0]?.payload).toMatchObject({
      result: { executionId: 'exec-1', output: 'plan' },
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('chatId');
  });

  it('rejects a payload scope that disagrees with the routed owner', async () => {
    const events = await prepare(
      {
        projectId: 'ws-1',
        worktreeId: 'wt-2',
        executionId: 'exec-1',
        output: 'plan',
      },
      owner,
    );

    expect(events).toMatchObject([
      {
        type: 'portal.command.failed',
        payload: { error: { code: 'invalid_target' } },
      },
    ]);
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(mockedQueryChatState).not.toHaveBeenCalled();
  });

  it.each([
    [{ projectId: 'ws-1', worktreeId: 'wt-1', output: 'plan' }],
    [{ projectId: 'ws-1', worktreeId: 'wt-1', executionId: 'exec-1' }],
    [
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        executionId: 'exec-1',
        output: 'diff',
      },
    ],
    [
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        executionId: 'exec-1',
        output: 'plan',
        prompt: 'Review this plan: /etc/passwd',
      },
    ],
  ])('rejects an invalid or path-carrying payload %#', async (payload) => {
    const events = await prepare(payload);

    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
    expect(mockedPrepare).not.toHaveBeenCalled();
  });

  it('passes the host reason through when the saved output is missing', async () => {
    mockedPrepare.mockRejectedValue(
      new PortalServiceError(
        'not_found',
        'This pipeline run does not have a saved plan file.',
      ),
    );

    const events = await prepare({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      output: 'plan',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.failed',
        payload: {
          error: {
            code: 'not_found',
            message: 'This pipeline run does not have a saved plan file.',
          },
        },
      }),
    ]);
    expect(mockedQueryChatState).not.toHaveBeenCalled();
  });
});

describe('pipeline content reads (CAN-3717)', () => {
  const mockedRead = jest.mocked(readPipelineContent);
  const owner = { workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1' };
  const page = {
    format: 'markdown' as const,
    content: '# Report',
    offset: 0,
    nextOffset: 8,
    length: 8,
    revision: 'r1',
  };

  async function read(
    payload: Record<string, unknown>,
    target: PortalCommandEnvelope['target'] = owner,
  ): Promise<PortalEventEnvelope[]> {
    const events: PortalEventEnvelope[] = [];
    await handlePortalPipelineContentRead(
      command('portal.pipeline.content.read', payload, target),
      adapterContext(events),
    );
    await new Promise((resolve) => setImmediate(resolve));
    return events;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRead.mockResolvedValue(page);
  });

  it('reads a page for the routed run owner', async () => {
    const events = await read({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      source: { kind: 'step_output', jobId: 'job-1', stepId: 'step-1' },
      offset: 8,
      revision: 'r1',
    });

    expect(mockedRead).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      source: { kind: 'step_output', jobId: 'job-1', stepId: 'step-1' },
      offset: 8,
      revision: 'r1',
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'portal.command.completed',
        payload: { result: page },
      }),
    ]);
  });

  it.each([
    ['a client path', { source: { kind: 'report', path: '/etc/hosts' } }],
    ['an unknown source', { source: { kind: 'plan' } }],
    ['an unknown key', { source: { kind: 'report' }, file: '/etc/hosts' }],
    ['a non-numeric offset', { source: { kind: 'report' }, offset: '8' }],
  ])('rejects %s', async (_name, extra) => {
    const events = await read({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      ...extra,
    });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_payload' } },
    });
  });

  it('rejects a payload scope that disagrees with the routed owner', async () => {
    const events = await read({
      projectId: 'ws-1',
      worktreeId: 'wt-2',
      executionId: 'exec-1',
      source: { kind: 'report' },
    });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: { error: { code: 'invalid_target' } },
    });
  });
});
