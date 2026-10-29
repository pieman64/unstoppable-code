import {
  createEmptyCostTotals,
  type CostAttributedItem,
  type CostChatRow,
  type CostProxyAccountRow,
  type PipelineRunCostView,
  type SessionBreakdownView,
} from '@canopy/protocol/cost-view';
import {
  chatViewNamesProxyAccounts,
  labelChatView,
  labelPipelineRunView,
  pipelineRunViewNamesProxyAccounts,
} from '../proxy-account-labels';

const SAM_KEY = 'proxy:conn-1:a1f3c2d4a1f3c2d4';
const LABELS = new Map([[SAM_KEY, 'sam@example.com']]);

const row: CostProxyAccountRow = {
  accountKey: SAM_KEY,
  label: '',
  turnShare: 1,
  requestCount: 2,
  usd: 0.2,
  notPricedCount: 0,
};
const unknownRow: CostProxyAccountRow = {
  ...row,
  accountKey: 'proxy:conn-1:e2a8f640e2a8f640',
};

const item: CostAttributedItem = {
  id: 'task-1',
  kind: 'claude_task',
  label: 'Claude task',
  billingBasis: 'account_proxy',
  tokens: createEmptyCostTotals().tokens,
  costStatus: 'estimated',
  inclusion: 'included',
  proxyAccounts: [{ accountKey: SAM_KEY, label: '' }],
};

const chat: CostChatRow = {
  chatId: 'chat-1',
  label: 'Chat',
  state: 'open',
  totals: createEmptyCostTotals(),
  turnCount: 1,
  lastActivityAt: '2026-10-08T12:00:00.000Z',
  running: false,
  models: [],
  proxyAccounts: [row, unknownRow],
};

describe('proxy account labels', () => {
  it('names the accounts of a full chat view and leaves unknown ones unnamed', () => {
    const breakdown: SessionBreakdownView = {
      chat,
      updatedAt: null,
      bySource: {
        chat: { usd: 0, turnCount: 1 },
        subagents: { usd: 0, items: [item] },
        delegations: { usd: 0, items: [] },
        background: { usd: 0, rows: [] },
      },
      chatTurnsByModel: [],
      byModel: [],
      context: { categories: [], timeline: [] },
      compactions: { total: 0, auto: 0, manual: 0 },
      activity: {
        turnCount: 1,
        totalDurationMs: 0,
        averageTurnMs: null,
        p95TurnMs: null,
        toolCallCount: 0,
        subagentCount: 1,
        plansCreated: 0,
        plansApproved: 0,
        topTools: [],
      },
    };
    const view = { kind: 'full' as const, breakdown };
    expect(chatViewNamesProxyAccounts(view)).toBe(true);
    const labelled = labelChatView(view, LABELS);
    if (labelled.kind !== 'full') throw new Error('expected a full view');
    expect(
      labelled.breakdown.chat.proxyAccounts?.map((account) => account.label),
    ).toEqual(['sam@example.com', '']);
    expect(
      labelled.breakdown.bySource.subagents.items[0]?.proxyAccounts,
    ).toEqual([{ accountKey: SAM_KEY, label: 'sam@example.com' }]);
  });

  it('names a subagent view and skips views the proxy did not serve', () => {
    const view = { kind: 'subagent' as const, chat, item };
    const labelled = labelChatView(view, LABELS);
    if (labelled.kind !== 'subagent') throw new Error('expected a subagent');
    expect(labelled.item.proxyAccounts?.[0]?.label).toBe('sam@example.com');
    expect(
      chatViewNamesProxyAccounts({
        kind: 'summary',
        chat: { ...chat, proxyAccounts: undefined },
      }),
    ).toBe(false);
  });

  it('names the accounts of each step and of the run', () => {
    const view: PipelineRunCostView = {
      run: {
        executionId: 'run-1',
        pipelineName: 'Build',
        startedAt: '2026-10-08T12:00:00.000Z',
        status: 'succeeded',
        totals: createEmptyCostTotals(),
        agentStepCount: 1,
      },
      updatedAt: null,
      steps: [
        {
          jobId: 'job',
          stepId: 'step',
          label: 'Step',
          attemptCount: 1,
          totals: createEmptyCostTotals(),
          executionId: 'run-1',
          proxyAccounts: [row],
        },
      ],
      subagents: [item],
      delegations: [],
      childRuns: [],
      byModel: [],
      byProxyAccount: [row],
    };
    expect(pipelineRunViewNamesProxyAccounts(view)).toBe(true);
    const labelled = labelPipelineRunView(view, LABELS);
    expect(labelled.steps[0]?.proxyAccounts?.[0]?.label).toBe(
      'sam@example.com',
    );
    expect(labelled.byProxyAccount?.[0]?.label).toBe('sam@example.com');
    expect(labelled.subagents[0]?.proxyAccounts?.[0]?.label).toBe(
      'sam@example.com',
    );
    expect(
      pipelineRunViewNamesProxyAccounts({
        ...view,
        steps: [],
        subagents: [],
        byProxyAccount: undefined,
      }),
    ).toBe(false);
  });
});
