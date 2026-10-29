/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { DesktopSubagentChatPanelHost } from '../DesktopSubagentChatPanelHost';
import { useSubagentTree, type SubagentTreeQuery } from '../useSubagentTree';
import { useSubagentWorktreeSummary } from '../useSubagentWorktreeSummary';

jest.mock('../useSubagentTree', () => ({
  useSubagentTree: jest.fn(),
}));
jest.mock('../useSubagentWorktreeSummary', () => ({
  useSubagentWorktreeSummary: jest.fn(),
}));
jest.mock('@canopy/ui-app/subagents', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/ui-app/subagents'),
  subagentCapabilitiesForKind: jest.fn(
    (capabilities: SubagentViewerCapabilities) => capabilities,
  ),
}));
jest.mock('../subagent-capabilities', () => ({
  useSubagentViewerCapabilities: jest.fn(() => ({
    stop: true,
    messaging: true,
    worktreeDetails: true,
    nativeInterrupt: true,
    openWorkflow: true,
    stopWorkflow: true,
  })),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function treeQuery(status: SubagentNode['status']): SubagentTreeQuery {
  const node: SubagentNode = {
    id: 'delegate',
    kind: 'managed',
    parentId: null,
    depth: 1,
    title: 'Write stories',
    status,
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    prompt: 'Write two stories.',
    runs: [{ runGeneration: 1 }],
  };
  const tree: SubagentTree = {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([[node.id, node]]),
    rootChildIds: [node.id],
    complete: true,
  };
  return {
    tree,
    treeState: { status: 'ready' },
    settled: true,
    rootChatOpen: true,
    hydrated: true,
    managedEntries: new Map(),
  };
}

describe('a running subagent chat', () => {
  it('shows new output as the subagent works', async () => {
    jest.useFakeTimers();
    let texts = ['Writing the first story.'];
    const transcript = jest.fn(
      (request: {
        readonly sinceRevision?: number;
      }): Promise<Record<string, unknown>> =>
        Promise.resolve({
          ok: true,
          task: {
            description: 'Write stories',
            prompt: 'Write two stories.',
            executionMode: 'background',
          },
          snapshot: {},
          runGeneration: 1,
          revision: texts.length,
          hasMore: false,
          ...(request.sinceRevision === texts.length
            ? { items: [], unchanged: true }
            : {
                items: texts.map((text, index) => ({
                  id: `item-${index}`,
                  sequence: index + 1,
                  occurredAt: index + 1,
                  type: 'text',
                  text,
                })),
              }),
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcriptPage: transcript } },
    });
    jest.mocked(useSubagentTree).mockReturnValue(treeQuery('running'));
    jest.mocked(useSubagentWorktreeSummary).mockReturnValue({});
    const container = document.createElement('div');
    const root = createRoot(container);
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };
    try {
      await act(async () => {
        root.render(
          <DesktopSubagentChatPanelHost
            scope={{ projectId: 'project', worktreeId: 'worktree' }}
            rootChatId="root-chat"
            subagentId="delegate"
            subagentKind="managed"
            panelId="panel"
            isVisible
            isActive
          />,
        );
        await settle();
      });
      expect(container.textContent).toContain('Writing the first story.');

      texts = [...texts, 'Writing the second story.'];
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await settle();
      });
      expect(container.textContent).toContain('Writing the second story.');
    } finally {
      act((): void => root.unmount());
      jest.useRealTimers();
    }
  });

  it('shows an edit to an item even when its length is unchanged', async () => {
    jest.useFakeTimers();
    let revision = 1;
    let text = 'Draft one.';
    const transcript = jest.fn(
      (request: {
        readonly sinceRevision?: number;
      }): Promise<Record<string, unknown>> =>
        Promise.resolve({
          ok: true,
          task: {
            description: 'Write stories',
            prompt: 'Write two stories.',
            executionMode: 'background',
          },
          snapshot: {},
          runGeneration: 1,
          revision,
          hasMore: false,
          ...(request.sinceRevision === revision
            ? { items: [], unchanged: true }
            : {
                items: [
                  {
                    id: 'item-0',
                    sequence: 1,
                    occurredAt: 1,
                    type: 'text',
                    text,
                  },
                ],
              }),
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { transcriptPage: transcript } },
    });
    jest.mocked(useSubagentTree).mockReturnValue(treeQuery('running'));
    jest.mocked(useSubagentWorktreeSummary).mockReturnValue({});
    const container = document.createElement('div');
    const root = createRoot(container);
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    };
    try {
      await act(async () => {
        root.render(
          <DesktopSubagentChatPanelHost
            scope={{ projectId: 'project', worktreeId: 'worktree' }}
            rootChatId="root-chat"
            subagentId="delegate"
            subagentKind="managed"
            panelId="panel"
            isVisible
            isActive
          />,
        );
        await settle();
      });
      expect(container.textContent).toContain('Draft one.');

      text = 'Draft two.';
      revision = 2;
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await settle();
      });
      expect(container.textContent).toContain('Draft two.');
      expect(container.textContent).not.toContain('Draft one.');
    } finally {
      act((): void => root.unmount());
      jest.useRealTimers();
    }
  });
});
