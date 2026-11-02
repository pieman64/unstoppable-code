/** @jest-environment jsdom */
// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import { TurnGroupView } from '../../TurnGroupView';
import { AgentArtifactTileHostProvider } from '../agent-artifact-tile-host';
import {
  PipelineRunReceiptHostProvider,
  type PipelineRunReceiptHost,
} from '../pipeline-run-receipt-host';
import { collectTurnAgentArtifacts } from '../turn-agent-artifacts';
import { TurnAgentArtifacts } from '../TurnAgentArtifacts';
import { useChatAgentActivityPlacement } from '../chat-agent-activity-placement';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';

jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCapabilities: (): { chatVisuals: boolean } => ({ chatVisuals: false }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, TextEncoder });
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { escape: (value: string): string => value },
});
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: (): void => undefined,
});

const CREATED_AT = '2026-10-16T12:00:00.000Z';

function runReceipt(
  runId: string,
  status: 'running' | 'success' | 'failure' = 'success',
): Record<string, unknown> {
  return {
    version: 1,
    kind: 'automation_run',
    operation: 'automation.run_now',
    dedupeKey: `canopy:automation_run:local:${runId}`,
    createdAt: CREATED_AT,
    activityId: 'act-1',
    runId,
    name: 'Nightly triage',
    status,
    trigger: 'manual',
    scheduledFor: CREATED_AT,
    startedAt: CREATED_AT,
    navigationTarget: {
      kind: 'automation_editor',
      activityId: 'act-1',
      section: 'runs',
      runId,
    },
  };
}

function sharedSkillReference(
  relation: 'found' | 'recommended',
): Record<string, unknown> {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'capabilities.show',
    dedupeKey: 'canopy:capability_reference:skill:shared:s1',
    createdAt: CREATED_AT,
    itemKind: 'skill',
    source: 'shared',
    sourceId: 's1',
    name: 'Code review',
    sourceLabel: 'Team',
    state: 'available',
    relation,
    navigationTarget: { kind: 'shared_skill', skillId: 's1' },
  };
}

const PIPELINE_RUN = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: 'canopy:pipeline_run:local:e1',
  createdAt: CREATED_AT,
  executionId: 'e1',
  pipelineId: 'p1',
  pipelineName: 'Ship',
  initialStatus: 'running',
  queuedAt: CREATED_AT,
  projectId: 'proj',
  worktreeId: 'wt',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'e1',
    projectId: 'proj',
    worktreeId: 'wt',
  },
};

function foundPipelineReference(): Record<string, unknown> {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'pipeline.get',
    dedupeKey: 'canopy:capability_reference:user:pipeline:p1',
    createdAt: CREATED_AT,
    itemKind: 'pipeline',
    source: 'user',
    sourceId: 'p1',
    name: 'Ship',
    sourceLabel: 'Local',
    state: 'installed',
    relation: 'found',
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId: 'p1',
      source: 'user',
    },
  };
}

function foundAutomationReference(): Record<string, unknown> {
  return {
    version: 1,
    kind: 'capability_reference',
    operation: 'automation.get',
    dedupeKey: 'canopy:capability_reference:local:automation:act-1',
    createdAt: CREATED_AT,
    itemKind: 'automation',
    source: 'local',
    sourceId: 'act-1',
    name: 'Nightly triage',
    sourceLabel: 'Local',
    state: 'installed',
    relation: 'found',
    navigationTarget: { kind: 'automation_editor', activityId: 'act-1' },
  };
}

const GITHUB_RUN = {
  version: 1,
  kind: 'github_workflow_run',
  operation: 'github.watch',
  dedupeKey: 'canopy:github_workflow_run:acme/api:101',
  createdAt: CREATED_AT,
  watcherId: 'gh-watch-1',
  repository: 'acme/api',
  runId: '101',
  runAttempt: 1,
  htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  state: { kind: 'intermediate', status: 'in_progress' },
  observedAt: CREATED_AT,
  navigationTarget: {
    kind: 'github_workflow_run',
    repository: 'acme/api',
    runId: '101',
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
  },
};

function message(
  id: string,
  parts: PortalChatMessage['parts'],
  role: PortalChatMessage['role'] = 'assistant',
): PortalChatMessage {
  return {
    messageId: id,
    chatId: 'c1',
    role,
    status: 'complete',
    text: role === 'user' ? 'hi' : '',
    createdAtMs: 0,
    ...(parts ? { parts } : {}),
  };
}

function foldedToolUse(
  toolUseId: string,
  agentArtifacts: unknown,
  isError = false,
): NonNullable<PortalChatMessage['parts']>[number] {
  return {
    kind: 'tool_use',
    data: {
      toolUseId,
      toolName: 'mcp__canopy__DispatchAction',
      input: '{}',
      result: { output: '{"ok":true,"res', isError, agentArtifacts },
    },
  };
}

function standaloneResult(
  toolUseId: string,
  agentArtifacts: unknown,
): NonNullable<PortalChatMessage['parts']>[number] {
  return {
    kind: 'tool_result',
    data: { toolUseId, output: 'truncated…', isError: false, agentArtifacts },
  };
}

describe('collectTurnAgentArtifacts', () => {
  it('reads folded and standalone results once per tool call, in order', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        foldedToolUse('t1', [runReceipt('run-1')]),
        standaloneResult('t1', [runReceipt('run-1')]),
      ]),
      message('a2', [standaloneResult('t2', [sharedSkillReference('found')])]),
    ]);
    expect(receipts.map((receipt) => receipt.dedupeKey)).toEqual([
      'canopy:automation_run:local:run-1',
      'canopy:capability_reference:skill:shared:s1',
    ]);
  });

  it('collapses repeat mentions to the latest receipt at its last position', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        standaloneResult('t1', [sharedSkillReference('found')]),
        standaloneResult('t2', [runReceipt('run-1')]),
        standaloneResult('t3', [sharedSkillReference('recommended')]),
      ]),
    ]);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({
      kind: 'capability_reference',
      relation: 'recommended',
    });
  });

  it('ignores errors and malformed receipts', () => {
    const malformed = { ...runReceipt('run-2'), durationMs: Number.NaN };
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        foldedToolUse('t1', [runReceipt('run-1')], true),
        standaloneResult('t2', [malformed]),
        standaloneResult('t3', 'not-an-array'),
        { kind: 'text', data: { text: '{"agentArtifacts":[]}' } },
      ]),
    ]);
    expect(receipts).toEqual([]);
  });

  it('keeps pipeline and GitHub workflow runs for the component to place', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [standaloneResult('t1', [PIPELINE_RUN, GITHUB_RUN])]),
    ]);
    expect(receipts).toEqual([PIPELINE_RUN, GITHUB_RUN]);
  });

  it('drops a found pipeline the same turn ran', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        standaloneResult('t1', [foundPipelineReference()]),
        standaloneResult('t2', [PIPELINE_RUN]),
      ]),
    ]);
    expect(receipts).toEqual([PIPELINE_RUN]);
  });

  it('drops a found automation the same turn triggered', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        standaloneResult('t1', [runReceipt('r1')]),
        standaloneResult('t2', [foundAutomationReference()]),
      ]),
    ]);
    expect(receipts).toEqual([runReceipt('r1')]);
  });

  it('keeps only the recommendation when a skill is found then recommended', () => {
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        standaloneResult('t1', [sharedSkillReference('found')]),
        standaloneResult('t2', [sharedSkillReference('recommended')]),
      ]),
    ]);
    expect(receipts).toEqual([sharedSkillReference('recommended')]);
  });

  it.each([
    [
      'separate tool results',
      [
        standaloneResult('t1', [sharedSkillReference('recommended')]),
        standaloneResult('t2', [sharedSkillReference('found')]),
      ],
    ],
    [
      'one tool result',
      [
        standaloneResult('t1', [
          sharedSkillReference('recommended'),
          sharedSkillReference('found'),
        ]),
      ],
    ],
  ])(
    'keeps the recommendation when a skill is recommended then found (%s)',
    (_, parts) => {
      const receipts = collectTurnAgentArtifacts([message('a1', parts)]);
      expect(receipts).toEqual([sharedSkillReference('recommended')]);
    },
  );
});

describe('TurnGroupView capability tiles', () => {
  function renderTurn(
    turnGroup: PortalChatTurnGroup,
    messages: PortalChatMessage[],
    withHost: boolean,
    runHost?: PipelineRunReceiptHost,
  ): HTMLDivElement {
    const byId = Object.fromEntries(
      messages.map((item) => [item.messageId, item]),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const turn = (
      <ChatLookProvider value="classic">
        <TurnGroupView turnGroup={turnGroup} messagesById={byId} />
      </ChatLookProvider>
    );
    const view = runHost ? (
      <PipelineRunReceiptHostProvider host={runHost}>
        {turn}
      </PipelineRunReceiptHostProvider>
    ) : (
      turn
    );
    act(() => {
      root.render(
        withHost ? (
          <AgentArtifactTileHostProvider
            host={{
              resolveAction: (receipt) =>
                receipt.kind === 'capability_reference'
                  ? { kind: 'link', href: '/portal/plugins/skills/shared/s1' }
                  : { kind: 'none', hint: 'Open on desktop' },
            }}
          >
            {view}
          </AgentArtifactTileHostProvider>
        ) : (
          view
        ),
      );
    });
    return container;
  }

  const messages = [
    message('u1', undefined, 'user'),
    message('a1', [
      foldedToolUse('t1', [runReceipt('run-1', 'failure')]),
      standaloneResult('t2', [sharedSkillReference('recommended')]),
    ]),
    message('a2', [{ kind: 'text', data: { text: 'Done' } }]),
  ];

  it('shows the turn tiles after its content, before the feedback row', () => {
    const container = renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
      },
      messages,
      true,
    );
    const run = container.querySelector(
      '[data-testid="agent-artifact-automation_run"]',
    );
    expect(run?.textContent).toContain('Failed');
    expect(run?.textContent).not.toContain('Open on desktop');
    expect(run?.getAttribute('aria-label')).toContain('Open on desktop');
    const reference = container.querySelector(
      '[data-testid="agent-artifact-capability_reference"]',
    );
    expect(reference?.tagName).toBe('A');
    expect(reference?.getAttribute('href')).toBe(
      '/portal/plugins/skills/shared/s1',
    );
  });

  it('places the tiles above the completion stamp, as desktop does', () => {
    const timer = message('t', [
      { kind: 'turn_timer', data: { startedAt: 0, completedAt: 6_000 } },
    ]);
    const container = renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2', 't'],
        complete: true,
      },
      [...messages, timer],
      true,
    );
    const html = container.innerHTML;
    const tiles = html.indexOf('data-capability-tile');
    expect(tiles).toBeGreaterThan(html.indexOf('Done'));
    expect(tiles).toBeLessThan(html.indexOf('Completed in'));
  });

  it('shows tiles while the turn is still running', () => {
    const container = renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: [],
        complete: false,
      },
      messages.slice(0, 2),
      true,
    );
    expect(container.querySelectorAll('[data-capability-tile]').length).toBe(2);
  });

  it('renders nothing for a turn with only a GitHub workflow run', () => {
    const container = renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: [],
        complete: true,
      },
      [
        message('u1', undefined, 'user'),
        message('a1', [standaloneResult('t1', [GITHUB_RUN])]),
      ],
      true,
    );
    expect(
      container.querySelector('[data-testid="agent-activity-completed"]'),
    ).toBeNull();
  });

  function renderPipelineRunTurn(
    receipts: unknown[],
    runHost?: PipelineRunReceiptHost,
  ): HTMLDivElement {
    return renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: [],
        complete: true,
      },
      [
        message('u1', undefined, 'user'),
        message(
          'a1',
          receipts.map((receipt, index) =>
            standaloneResult(`t${index}`, [receipt]),
          ),
        ),
      ],
      true,
      runHost,
    );
  }

  it('renders the pipeline run card from the receipt without a run host', () => {
    const container = renderPipelineRunTurn([PIPELINE_RUN]);
    const section = container.querySelector(
      '[data-testid="agent-activity-completed"]',
    );
    const card = section?.querySelector('[data-testid="pipeline-run-card-e1"]');
    expect(card?.textContent).toContain('Ship');
    expect(
      container.querySelector('[data-testid="pipeline-run-cancel-e1"]'),
    ).toBeNull();
  });

  it('offers Cancel when the run host can cancel', () => {
    const onCancel = jest.fn();
    const container = renderPipelineRunTurn([PIPELINE_RUN], {
      summaries: [
        {
          id: 'e1',
          pipeline_id: 'p1',
          pipeline_name: 'Ship',
          status: 'running',
          status_reasons: [],
          started_at: CREATED_AT,
        },
      ],
      statesById: {},
      actions: { onCancel },
    });
    const cancel = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-run-cancel-e1"]',
    );
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledWith('e1');
  });

  it('shows the run host pending cancel', () => {
    const container = renderPipelineRunTurn([PIPELINE_RUN], {
      summaries: [],
      statesById: {},
      actions: { onCancel: jest.fn() },
      pending: { cancellingId: 'e1' },
    });
    expect(
      container.querySelector('[data-testid="pipeline-run-cancel-e1"]')
        ?.textContent,
    ).toBe('Cancelling…');
  });

  it('shows one run card and no Found tile when the turn found and ran a pipeline', () => {
    const container = renderPipelineRunTurn([
      foundPipelineReference(),
      PIPELINE_RUN,
    ]);
    expect(
      container.querySelectorAll('[data-testid^="pipeline-run-card-"]').length,
    ).toBe(1);
    expect(
      container.querySelector(
        '[data-testid="agent-artifact-capability_reference"]',
      ),
    ).toBeNull();
  });

  it('renders unlinked tiles where no host is mounted', () => {
    const container = renderTurn(
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: ['a2'],
        complete: true,
      },
      messages,
      false,
    );
    expect(
      container.querySelector(
        '[data-capability-tile] a, [data-capability-tile] button',
      ),
    ).toBeNull();
    expect(container.querySelectorAll('[data-capability-tile]').length).toBe(2);
  });
});

describe('TurnAgentArtifacts placed receipts', () => {
  function render(
    receipts: Parameters<typeof TurnAgentArtifacts>[0]['receipts'],
  ): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <TurnAgentArtifacts
            messages={[message('a1', [standaloneResult('t1', [PIPELINE_RUN])])]}
            receipts={receipts}
          />
        </ChatLookProvider>,
      ),
    );
    return container;
  }

  // CAN-4690: a chat view places each run in one turn; a turn whose run lives
  // elsewhere renders no card for it.
  it('lists the placed receipts instead of the turn’s own', () => {
    expect(
      render([]).querySelector('[data-testid="agent-activity-completed"]'),
    ).toBeNull();
  });

  it('collects from the messages when no receipts are placed', () => {
    expect(
      render(undefined).querySelector('[data-testid="pipeline-run-card-e1"]'),
    ).not.toBeNull();
  });
});

describe('useChatAgentActivityPlacement', () => {
  const WATCHED_RUN = { ...PIPELINE_RUN, operation: 'pipeline.watch' };

  function Probe({
    turnGroups,
    messagesById,
  }: {
    turnGroups: PortalChatTurnGroup[];
    messagesById: Record<string, PortalChatMessage>;
  }): JSX.Element {
    const byTurn = useChatAgentActivityPlacement(turnGroups, messagesById);
    return (
      <pre data-testid="placement">
        {JSON.stringify(
          Object.fromEntries(
            Object.entries(byTurn).map(([turn, receipts]) => [
              turn,
              receipts.map((receipt) => receipt.operation),
            ]),
          ),
        )}
      </pre>
    );
  }

  // CAN-4690: a run launched in one turn and watched in a later one renders
  // once, in the turn that launched it.
  it('places each run in one turn across the chat', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const messagesById = {
      a1: message('a1', [standaloneResult('t1', [PIPELINE_RUN])]),
      a2: message('a2', [standaloneResult('t2', [WATCHED_RUN])]),
    };
    const turnGroups: PortalChatTurnGroup[] = [
      {
        userMessageId: 'u1',
        intermediateMessageIds: ['a1'],
        finalMessageIds: [],
        complete: true,
      },
      {
        userMessageId: 'u2',
        intermediateMessageIds: ['a2'],
        finalMessageIds: [],
        complete: true,
      },
    ];
    act(() =>
      root.render(
        <ChatLookProvider value="classic">
          <Probe turnGroups={turnGroups} messagesById={messagesById} />
        </ChatLookProvider>,
      ),
    );
    expect(
      JSON.parse(
        container.querySelector('[data-testid="placement"]')?.textContent ??
          '{}',
      ),
    ).toEqual({ u1: ['pipeline.run'], u2: [] });
  });
});
