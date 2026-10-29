/** @jest-environment jsdom */
// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  PortalChatMessage,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';
import { TurnGroupView } from '../../TurnGroupView';
import { AgentArtifactTileHostProvider } from '../agent-artifact-tile-host';
import { collectTurnAgentArtifacts } from '../turn-agent-artifacts';

jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): { chatVisuals: boolean } => ({ chatVisuals: false }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, TextEncoder });

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

  it('ignores errors, malformed receipts and specialized run rows', () => {
    const malformed = { ...runReceipt('run-2'), durationMs: Number.NaN };
    const receipts = collectTurnAgentArtifacts([
      message('a1', [
        foldedToolUse('t1', [runReceipt('run-1')], true),
        standaloneResult('t2', [malformed, PIPELINE_RUN]),
        standaloneResult('t3', 'not-an-array'),
        { kind: 'text', data: { text: '{"agentArtifacts":[]}' } },
      ]),
    ]);
    expect(receipts).toEqual([]);
  });
});

describe('TurnGroupView capability tiles', () => {
  function renderTurn(
    turnGroup: PortalChatTurnGroup,
    messages: PortalChatMessage[],
    withHost: boolean,
  ): HTMLDivElement {
    const byId = Object.fromEntries(
      messages.map((item) => [item.messageId, item]),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const view = <TurnGroupView turnGroup={turnGroup} messagesById={byId} />;
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
    expect(run?.textContent).toContain('Open on desktop');
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
