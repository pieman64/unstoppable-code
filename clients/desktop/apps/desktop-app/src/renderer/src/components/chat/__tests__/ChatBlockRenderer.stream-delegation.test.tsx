/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { ChatBlockRenderer } from '../ChatBlockRenderer';
import { DelegationTranscriptSourceContext } from '../delegated-agent-transcript';
import type { DisplayBlock } from '../types';

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

const STALE = 'stale inline child sentinel';
const client: CanopyClient = {
  capabilities: {
    overviewNotifications: false,
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'read',
    voice: false,
    settingsScope: 'api-keys-only',
    pipelines: 'crud-only',
    routing: 'in-memory',
  },
  query: (): Promise<never> => Promise.reject(new Error('Unused query')),
  command: (): Promise<never> => Promise.reject(new Error('Unused command')),
  subscribe: (): (() => void) => (): void => {},
};

function managedBlock(transcriptStore?: 'chat-stream-v2'): DisplayBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: 'managed-block',
    delegationId: 'managed-id',
    parentTurnId: 'turn-1',
    sequence: 1,
    createdAt: 1,
    selectedModelId: 'sonnet',
    runtimeModelId: 'sonnet',
    targetHarnessId: 'claude',
    parentToolCallId: 'spawn',
    parentHarnessId: 'claude',
    description: 'Managed review',
    prompt: 'Review the change',
    executionMode: 'background',
    status: 'completed',
    runGeneration: 4,
    outputTruncated: false,
    ...(transcriptStore ? { transcriptStore } : {}),
    subBlocks: [{ type: 'text', text: STALE }],
  };
}

describe('ChatBlockRenderer stream-backed delegation cards', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderExpanded(block: DisplayBlock): void {
    act(() =>
      root.render(
        <CanopyClientProvider client={client}>
          <DelegationTranscriptSourceContext.Provider
            value={{ projectId: 'project', worktreeId: 'tree', chatId: 'chat' }}
          >
            <ChatBlockRenderer block={block} originChatTabId="chat" />
          </DelegationTranscriptSourceContext.Provider>
        </CanopyClientProvider>,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    if (!toggle) throw new Error('Missing managed card toggle');
    act(() => toggle.click());
  }

  it('shows the shared unavailable state instead of committed child blocks', () => {
    renderExpanded(managedBlock('chat-stream-v2'));
    const notice = container.querySelector(
      '[data-testid="delegation-child-pages-unavailable"]',
    );
    expect(notice?.textContent).toBe("Couldn't load messages in this view.");
    expect(notice?.getAttribute('data-target-delegation-id')).toBe(
      'managed-id',
    );
    expect(notice?.getAttribute('data-target-run-generation')).toBe('4');
    expect(container.textContent).not.toContain(STALE);
  });

  it('keeps an inline card rendering its child blocks', () => {
    renderExpanded(managedBlock());
    expect(container.textContent).toContain(STALE);
    expect(
      container.querySelector(
        '[data-testid="delegation-child-pages-unavailable"]',
      ),
    ).toBeNull();
  });
});
