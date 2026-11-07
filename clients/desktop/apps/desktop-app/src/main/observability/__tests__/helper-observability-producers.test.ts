// CAN-5096: helper calls and usage events write their audit entries,
// transcripts and usage events through the agent ingest port, from inside
// the helper's worker run, and never through the desktop service, so
// observability:load-history, observability:load-transcript and
// observability:load-usage-metrics read the same records.
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { runHelperThroughWorker } from '../../helper-runs/helper-runs';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../../lib/helper-observed-task';
import { createHelperTranscriptObserver } from '../../lib/helper-transcript-observer';
import { recordPipelineUsageEvent } from '../../pipelines/pipeline-usage-events';
import type * as InlineHelperRuns from '../../__tests__/helpers/inline-helper-runs';
import { CLAUDE_MODEL, pipelineState, runEvent } from './golden/fixtures';

type RecordedCall = [string, ...unknown[]];

jest.mock(
  '../index',
  (): {
    getObservabilityService: () => never;
    peekObservabilityService: () => null;
  } => ({
    getObservabilityService: (): never => {
      throw new Error('service used directly');
    },
    peekObservabilityService: (): null => null,
  }),
);
jest.mock(
  '../ingest',
  (): {
    getExecutionObservabilityIngest: () => object;
    __port: object;
    __calls: RecordedCall[];
  } => {
    const calls: RecordedCall[] = [];
    const methods = [
      'startChatTurn',
      'observeChatEvent',
      'completeChatTurn',
      'pauseChatTurn',
      'resumeChatTurn',
      'recordInjectedPromptForOpenChatTurn',
      'observeSteeringInput',
      'setChatTurnServedModel',
      'setChatTurnAccountProxyRouted',
      'beginClaudeQuery',
      'endClaudeQuery',
      'startObservedTask',
      'updateObservedTask',
      'finalizeObservedTask',
      'interruptMatchingEntries',
      'seedTranscript',
      'appendTranscriptRecord',
      'observeClaudeEvent',
      'appendFinalizedChatTranscriptRecord',
      'markObservedTaskAccountProxyRouted',
      'recordUsageMetricEvent',
      'recordCreatedPullRequest',
      'recordSessionDiagnostic',
    ];
    const port = Object.fromEntries(
      methods.map((method) => [
        method,
        (...args: unknown[]): void => {
          calls.push([method, ...args]);
        },
      ]),
    );
    return {
      getExecutionObservabilityIngest: (): object => port,
      __port: port,
      __calls: calls,
    };
  },
);
jest.mock(
  '../../canopy-runtime/desktop-runtime',
  (): { getActiveDesktopRuntimeIfAccepting: () => null } => ({
    getActiveDesktopRuntimeIfAccepting: (): null => null,
  }),
);
jest.mock('../../helper-runs/helper-runs', (): unknown =>
  jest
    .requireActual<
      typeof InlineHelperRuns
    >('../../__tests__/helpers/inline-helper-runs')
    .inlineHelperRunsModule(),
);

const calls = jest.requireMock<{ __calls: RecordedCall[] }>(
  '../ingest',
).__calls;

function runCommitHelperBody(): void {
  startObservedHelperTask({
    taskKey: 'helper:commit:1',
    eventType: 'commit_message_generation',
    label: 'Commit message',
    model: CLAUDE_MODEL,
    auditContext: { projectId: 'p', worktreeId: 'w' },
  });
}

describe('helper observability producers on the ingest port', () => {
  beforeEach(() => {
    initClaudeModels([{ id: CLAUDE_MODEL, label: 'Sonnet' }]);
    calls.length = 0;
  });

  it('a helper run through the worker writes its audit entry and transcript only through the port', async () => {
    await runHelperThroughWorker({
      kind: 'commit_message_generation',
      model: CLAUDE_MODEL,
      scope: { workspaceId: 'p', worktreeId: 'w' },
      origin: 'system',
      usageOf: () => undefined,
      launch: (): Promise<string> => {
        runCommitHelperBody();
        const observer = createHelperTranscriptObserver('helper:commit:1');
        void observer.seed({
          provider: 'claude',
          originalText: 'o',
          submittedText: 's',
          systemPrompt: 'sys',
        });
        void observer.appendEvent({ type: 'assistant' });
        void observer.markAttempt?.(2);
        finalizeObservedHelperTask('helper:commit:1', 'success', undefined, {
          inputTokens: 3,
        });
        return Promise.resolve('ok');
      },
    });

    expect(calls.map(([method]) => method)).toEqual([
      'startObservedTask',
      'seedTranscript',
      'appendTranscriptRecord',
      'updateObservedTask',
      'finalizeObservedTask',
    ]);
    expect(calls[0]?.[2]).toMatchObject({
      id: 'helper:commit:1',
      eventType: 'commit_message_generation',
      status: 'running',
    });
    expect(calls[4]?.slice(1)).toEqual([
      'helper:commit:1',
      'success',
      undefined,
      { inputTokens: 3 },
    ]);
  });

  it('a replayed helper run writes one audit entry and no usage from the run outcome', async () => {
    const outcomes = new KeyedOutcomes<{
      status: string;
      usage: { inputTokens: number };
    }>({ reusedError: (): Error => new Error('reused') });
    const context = {
      metadata: { idempotencyKey: 'k1' },
      caller: { principalId: 'core' },
    } as unknown as CanopyHandlerContext;
    const body = (): Promise<{
      status: string;
      usage: { inputTokens: number };
    }> => {
      runCommitHelperBody();
      finalizeObservedHelperTask('helper:commit:1', 'success');
      return Promise.resolve({
        status: 'succeeded',
        usage: { inputTokens: 3 },
      });
    };

    const first = await outcomes.run(
      context,
      { kind: 'commit_message_generation' },
      body,
    );
    const second = await outcomes.run(
      context,
      { kind: 'commit_message_generation' },
      body,
    );

    expect(second).toBe(first);
    const methods = calls.map(([method]) => method);
    expect(methods.filter((m) => m === 'startObservedTask')).toHaveLength(1);
    expect(methods.filter((m) => m === 'finalizeObservedTask')).toHaveLength(1);
    expect(methods).not.toContain('recordUsageMetricEvent');
  });

  it('usage events write through the port', () => {
    const state = {
      ...pipelineState({
        id: 'exec-usage',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        jobs: {},
      }),
      project_id: 'p',
    };

    recordPipelineUsageEvent(
      runEvent('execution.started', state, '2026-01-01T00:00:00.000Z'),
    );

    const usage = calls.filter(
      ([method]) => method === 'recordUsageMetricEvent',
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.[1]).toMatchObject({
      id: 'pipeline-run-started:exec-usage',
      type: 'pipeline_run_started',
    });
  });
});
