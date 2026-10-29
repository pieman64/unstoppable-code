/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DesktopAgentActivitySection } from '../DesktopAgentActivitySection';
import {
  SubagentEntryActionsContext,
  type SubagentEntryActions,
} from '@/components/subagents/subagent-entry-actions';

jest.mock('@/lib/terminal-instances', () => ({
  getOrCreateInstance: jest.fn(),
  peekInstance: jest.fn(() => undefined),
  TERMINAL_BG_COLOR: '#0b0c10',
}));

jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('DesktopAgentActivitySection View tree entry action', () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: SubagentEntryActions;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    actions = {
      rootChatId: 'root-chat',
      openSubagentChat: jest.fn(),
      viewTree: jest.fn(),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderSection(options: {
    provider: boolean;
    agentItems: readonly JSX.Element[];
  }): void {
    const section = (
      <DesktopAgentActivitySection
        artifacts={[]}
        agentItems={options.agentItems}
        variant="active"
        chatTarget={{
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'root-chat',
        }}
        liveDelegationIds={['live-delegation']}
        onStopAllDelegations={(): Promise<boolean> => Promise.resolve(true)}
      />
    );
    act(() =>
      root.render(
        options.provider ? (
          <SubagentEntryActionsContext.Provider value={actions}>
            {section}
          </SubagentEntryActionsContext.Provider>
        ) : (
          section
        ),
      ),
    );
  }

  it('shows View tree only with entry actions and agent items', () => {
    renderSection({ provider: false, agentItems: [<div key="agent" />] });
    expect(
      container.querySelector('[data-testid="agent-activity-view-tree"]'),
    ).toBeNull();

    renderSection({ provider: true, agentItems: [] });
    expect(
      container.querySelector('[data-testid="agent-activity-view-tree"]'),
    ).toBeNull();

    renderSection({ provider: true, agentItems: [<div key="agent" />] });
    const viewTree = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-activity-view-tree"]',
    );
    const stopAll = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-activity-stop-all"]',
    );
    if (!viewTree || !stopAll) {
      throw new Error('Missing one of the agent activity header actions');
    }
    expect(
      viewTree.compareDocumentPosition(stopAll) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('calls the current chat action when View tree is clicked', () => {
    renderSection({ provider: true, agentItems: [<div key="agent" />] });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-activity-view-tree"]',
    );
    if (!button) throw new Error('Missing View tree action');

    act(() => button.click());
    expect(actions.viewTree).toHaveBeenCalledTimes(1);
  });
});
