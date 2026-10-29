/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentChatTarget } from '@canopy/ui-shared';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import type { DisplayBlock } from '../types';
import {
  SubagentEntryActionsContext,
  useSubagentOpenChatCallback,
  type SubagentEntryActions,
} from '@/components/subagents/subagent-entry-actions';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));
jest.mock('@/lib/openFileInBrowserPanel', () => ({
  isBrowserRenderedFile: (filename: string): boolean =>
    /\.html?$/i.test(filename),
  openFileInBrowserPanel: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const nestedManagedBlock = (): DisplayBlock => ({
  type: 'delegated_agent_call',
  agentBlockId: 'nested-managed-block',
  delegationId: 'nested-managed-id',
  parentTurnId: 'turn-1',
  sequence: 2,
  createdAt: 2,
  selectedModelId: 'sonnet',
  runtimeModelId: 'sonnet',
  targetHarnessId: 'claude',
  parentToolCallId: 'spawn-nested',
  parentHarnessId: 'claude',
  description: 'Nested managed task',
  prompt: 'Inspect nested work',
  executionMode: 'background',
  status: 'completed',
  runGeneration: 1,
  outputTruncated: false,
  subBlocks: [],
});

function managedBlock(
  delegationId: string,
  description: string,
  subBlocks: DisplayBlock[] = [],
): DisplayBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: `managed-block-${delegationId}`,
    delegationId,
    parentTurnId: 'turn-1',
    sequence: 1,
    createdAt: 1,
    selectedModelId: 'sonnet',
    runtimeModelId: 'sonnet',
    targetHarnessId: 'claude',
    parentToolCallId: `spawn-${delegationId}`,
    parentHarnessId: 'claude',
    description,
    prompt: `Work on ${description}`,
    executionMode: 'background',
    status: 'completed',
    runGeneration: 1,
    outputTruncated: false,
    subBlocks,
  };
}

const claudeAgentBlock: DisplayBlock = {
  type: 'agent',
  toolUseId: 'claude-tool-use',
  subagentType: 'Explore',
  description: 'Claude native task',
  prompt: 'Inspect the code',
  runInBackground: true,
  result: { output: 'Done', isError: false },
  subBlocks: [],
};

function codexAgentBlock(
  receiverThreadIds: string[],
  description = 'Codex native task',
): DisplayBlock {
  return {
    type: 'codex_agent',
    agentBlockId: 'codex-block-id',
    callId: 'codex-call-id',
    status: 'completed',
    senderThreadId: 'root-thread',
    receiverThreadIds,
    prompt: 'Inspect the code',
    description,
    displayName: 'Codex reviewer',
    agentsStates: {},
    subBlocks: [],
  };
}

describe('ChatBlockRenderer subagent entry actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let openSubagentChat: jest.Mock<void, [SubagentChatTarget]>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openSubagentChat = jest.fn<void, [SubagentChatTarget]>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  function renderBlock(block: DisplayBlock, withProvider = true): void {
    const content = (
      <ChatBlockRenderer block={block} originChatTabId="root-chat" />
    );
    const actions: SubagentEntryActions = {
      rootChatId: 'root-chat',
      openSubagentChat,
      viewTree: jest.fn(),
    };
    act(() =>
      root.render(
        withProvider ? (
          <SubagentEntryActionsContext.Provider value={actions}>
            {content}
          </SubagentEntryActionsContext.Provider>
        ) : (
          content
        ),
      ),
    );
  }

  function expandCard(index = 0): void {
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="agent-block"] button[aria-expanded], [data-testid="agent-block-shared"] button[aria-expanded]',
    );
    const button = buttons.item(index);
    if (!button) throw new Error(`Missing agent card ${index}`);
    act(() => button.click());
  }

  function openChatButtons(): NodeListOf<HTMLButtonElement> {
    return container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="agent-card-open-chat"]',
    );
  }

  it('opens a managed card with its delegation id and description', () => {
    renderBlock(managedBlock('managed-id', 'Managed review'));
    expandCard();
    const button = openChatButtons().item(0);
    if (!button) throw new Error('Missing managed Open chat button');

    act(() => button.click());
    expect(openSubagentChat).toHaveBeenCalledWith({
      kind: 'managed',
      id: 'managed-id',
      title: 'Managed review',
    });
  });

  it('opens the nested managed card with its own identity', () => {
    renderBlock(
      managedBlock('parent-managed-id', 'Parent task', [nestedManagedBlock()]),
    );
    expandCard();
    expandCard(1);
    const button = openChatButtons().item(1);
    if (!button) throw new Error('Missing nested Open chat button');

    act(() => button.click());
    expect(openSubagentChat).toHaveBeenCalledWith({
      kind: 'managed',
      id: 'nested-managed-id',
      title: 'Nested managed task',
    });
  });

  it('opens a Claude native card with its tool-use id and description', () => {
    renderBlock(claudeAgentBlock);
    expandCard();
    const button = openChatButtons().item(0);
    if (!button) throw new Error('Missing Claude Open chat button');

    act(() => button.click());
    expect(openSubagentChat).toHaveBeenCalledWith({
      kind: 'claude-native',
      id: 'claude-tool-use',
      title: 'Claude native task',
    });
  });

  it('opens a Codex native card with its first receiver thread id', () => {
    renderBlock(codexAgentBlock(['codex-thread-id']));
    expandCard();
    const button = openChatButtons().item(0);
    if (!button) throw new Error('Missing Codex Open chat button');

    act(() => button.click());
    expect(openSubagentChat).toHaveBeenCalledWith({
      kind: 'codex-native',
      id: 'codex-thread-id',
      title: 'Codex native task',
    });
  });

  it('uses the Codex block id and display name when receiver details are empty', () => {
    renderBlock(codexAgentBlock([], ''));
    expandCard();
    const button = openChatButtons().item(0);
    if (!button) throw new Error('Missing Codex Open chat button');

    act(() => button.click());
    expect(openSubagentChat).toHaveBeenCalledWith({
      kind: 'codex-native',
      id: 'codex-block-id',
      title: 'Codex reviewer',
    });
  });

  it.each([
    ['managed', managedBlock('managed-id', 'Managed review')],
    ['Claude', claudeAgentBlock],
    ['Codex', codexAgentBlock(['codex-thread-id'])],
  ])(
    'does not show Open chat for a %s card without a provider',
    (_name, block) => {
      renderBlock(block, false);
      expandCard();
      expect(openChatButtons()).toHaveLength(0);
    },
  );
});

describe('subagent Open chat callback stability', () => {
  let container: HTMLDivElement;
  let root: Root;
  let callbacks: Array<(() => void) | undefined>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    callbacks = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function CallbackProbe({ revision }: { revision: number }): JSX.Element {
    const callback = useSubagentOpenChatCallback(
      'managed',
      'stable-managed-id',
      'Stable title',
    );
    callbacks.push(callback);
    return <span>{revision}</span>;
  }

  it('keeps a card callback stable across unrelated parent updates', () => {
    const actions: SubagentEntryActions = {
      rootChatId: 'root-chat',
      openSubagentChat: jest.fn<void, [SubagentChatTarget]>(),
      viewTree: jest.fn(),
    };
    const render = (revision: number): void => {
      act(() =>
        root.render(
          <SubagentEntryActionsContext.Provider value={actions}>
            <CallbackProbe revision={revision} />
          </SubagentEntryActionsContext.Provider>,
        ),
      );
    };

    render(0);
    render(1);

    expect(callbacks).toHaveLength(2);
    expect(callbacks[1]).toBe(callbacks[0]);
  });
});
