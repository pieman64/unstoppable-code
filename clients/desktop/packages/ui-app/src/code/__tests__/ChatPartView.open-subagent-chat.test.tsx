/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentDelegationCardData } from '@canopy/protocol/delegation';
import type { PortalChatPart } from '@canopy/protocol/portal';
import { SUBAGENT_OPEN_CHAT_LABEL } from '@canopy/ui-shared';
import { ChatPartView } from '../ChatPartView';
import {
  SubagentChatActionsContext,
  type SubagentChatActions,
} from '../subagents/SubagentChatActionsContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const delegation: AgentDelegationCardData = {
  delegationId: 'child-1',
  status: 'completed',
  outputTruncated: false,
  routeSnapshot: {
    selectedModelId: 'model',
    runtimeModelId: 'model',
    harnessId: 'codex',
    runtimeKind: 'local',
    runnerRegistrationId: 'runner',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'agent',
    providerType: 'custom',
    assignmentRevision: '1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: '1',
  },
  parentHarnessId: 'codex',
  description: 'Review source',
  prompt: 'Read source',
  executionMode: 'background',
};

const managedPart: PortalChatPart = {
  kind: 'agent',
  data: { delegation },
};

function mount(
  part: PortalChatPart,
  actions?: SubagentChatActions,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  const root = createRoot(container);
  const view = <ChatPartView part={part} />;
  const content: ReactNode = actions ? (
    <SubagentChatActionsContext.Provider value={actions}>
      {view}
    </SubagentChatActionsContext.Provider>
  ) : (
    view
  );
  act((): void => root.render(content));
  return { container, root };
}

function expandFirst(container: HTMLDivElement): void {
  const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded]');
  if (!toggle) throw new Error('Agent card expand control was not rendered.');
  act((): void => toggle.click());
}

function openChat(container: HTMLDivElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes(SUBAGENT_OPEN_CHAT_LABEL),
    ) ?? null
  );
}

describe('ChatPartView Open chat on agent cards', () => {
  it('opens a managed card with its identity and description', () => {
    const onOpenSubagentChat = jest.fn();
    const { container, root } = mount(managedPart, { onOpenSubagentChat });

    expandFirst(container);
    const action = openChat(container);
    expect(action).not.toBeNull();
    act((): void => action?.click());
    expect(onOpenSubagentChat).toHaveBeenCalledWith({
      kind: 'managed',
      id: 'child-1',
      title: 'Review source',
    });

    act((): void => root.unmount());
  });

  it('opens a nested managed card rendered in a native agent sub-block', () => {
    const onOpenSubagentChat = jest.fn();
    const nestedPart: PortalChatPart = {
      kind: 'agent',
      data: {
        subagentType: 'Coordinator',
        subBlocks: [{ kind: 'agent', data: { delegation } }],
      },
    };
    const { container, root } = mount(nestedPart, { onOpenSubagentChat });

    expandFirst(container);
    const nestedToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand delegated task"]',
    );
    if (!nestedToggle) throw new Error('Nested managed card was not rendered.');
    act((): void => nestedToggle.click());
    const action = openChat(container);
    expect(action).not.toBeNull();
    act((): void => action?.click());
    expect(onOpenSubagentChat).toHaveBeenCalledWith({
      kind: 'managed',
      id: 'child-1',
      title: 'Review source',
    });

    act((): void => root.unmount());
  });

  it('does not add the action without a host context', () => {
    const { container, root } = mount(managedPart);

    expandFirst(container);
    expect(openChat(container)).toBeNull();

    act((): void => root.unmount());
  });

  it('opens a native Claude card by its spawn tool-use id', () => {
    const onOpenSubagentChat = jest.fn();
    const nativePart: PortalChatPart = {
      kind: 'agent',
      data: {
        toolUseId: 'toolu_child',
        taskId: 'a0000000-0000-4000-8000-000000000001',
        subagentType: 'Explore',
        description: 'Find tests',
      },
    };
    const { container, root } = mount(nativePart, { onOpenSubagentChat });

    expandFirst(container);
    const action = openChat(container);
    expect(action).not.toBeNull();
    act((): void => action?.click());
    expect(onOpenSubagentChat).toHaveBeenCalledWith({
      kind: 'claude-native',
      id: 'toolu_child',
      title: 'Find tests',
    });

    act((): void => root.unmount());
  });

  it('offers no Open chat on an Agent tool call that carries no task (agent tasks off)', () => {
    const toolCall: PortalChatPart = {
      kind: 'tool_use',
      toolFamily: 'agent',
      data: {
        toolUseId: 'toolu_child',
        toolName: 'Agent',
        input: '{"subagent_type":"Explore","description":"Find tests"}',
      },
    };
    const onOpenSubagentChat = jest.fn();
    const { container, root } = mount(toolCall, { onOpenSubagentChat });

    expect(
      container.querySelector('[data-testid="chat-agent-block"]'),
    ).toBeNull();
    expect(openChat(container)).toBeNull();
    expect(onOpenSubagentChat).not.toHaveBeenCalled();

    act((): void => root.unmount());
  });

  it('does not open a Codex card until it has a native identity', () => {
    const codexPart: PortalChatPart = {
      kind: 'agent',
      data: {
        provider: 'codex',
        toolUseId: 'call_child',
        subagentType: 'Worker',
        description: 'Find tests',
      },
    };
    const { container, root } = mount(codexPart, {
      onOpenSubagentChat: jest.fn(),
    });

    expandFirst(container);
    expect(openChat(container)).toBeNull();

    act((): void => root.unmount());
  });

  it('does not add an action to a native agent card without a tool-use id', () => {
    const nativePart: PortalChatPart = {
      kind: 'agent',
      data: { subagentType: 'Explore', description: 'Find tests' },
    };
    const { container, root } = mount(nativePart, {
      onOpenSubagentChat: jest.fn(),
    });

    expandFirst(container);
    expect(openChat(container)).toBeNull();

    act((): void => root.unmount());
  });
});
