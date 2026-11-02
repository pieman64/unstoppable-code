/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelGroupModel } from '@canopy/ui-shared/panels';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { ChatGroupArchivedChatsAccessory } from '../ChatGroupArchivedChatsAccessory';

jest.mock('@/components/chat/ArchivedChatsControl', () => ({
  ArchivedChatsControl: (): JSX.Element => (
    <div data-testid="archived-chats-control" />
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

function groupModel(groupId: string): PanelGroupModel {
  return { groupId, tabs: [], activePanelId: null };
}

describe('ChatGroupArchivedChatsAccessory owner group', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
        { kind: 'file-diff', groupId: 'group-diff', panelId: 'panel-diff' },
      ],
      containerSize: { width: 1200, height: 800 },
    });
    // A non-chat group is maximized: the chat group is hidden.
    store.maximizeGroup(KEY, 'group-diff', true);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    usePanelLayoutStore.getState().disposeLayout(KEY);
  });

  function renderGroups(variant: 'header' | 'tabStrip'): {
    chat: Element | null;
    diff: Element | null;
  } {
    const accessory = (groupId: string): JSX.Element => (
      <div data-testid={groupId}>
        <ChatGroupArchivedChatsAccessory
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          group={groupModel(groupId)}
          primarySurface={variant === 'tabStrip'}
          variant={variant}
        />
      </div>
    );
    act(() => {
      root.render(
        <>
          {accessory('group-chat')}
          {accessory('group-diff')}
        </>,
      );
    });
    return {
      chat: container.querySelector('[data-testid="group-chat"]'),
      diff: container.querySelector('[data-testid="group-diff"]'),
    };
  }

  it('keeps the header-style control on the chat group (develop behavior)', () => {
    const { chat, diff } = renderGroups('header');

    expect(
      chat?.querySelector('[data-testid="archived-chats-control"]'),
    ).not.toBeNull();
    expect(
      diff?.querySelector('[data-testid="archived-chats-control"]'),
    ).toBeNull();
  });

  it('moves the tab-strip control to the visible maximized group', () => {
    const { chat, diff } = renderGroups('tabStrip');

    expect(
      chat?.querySelector('[data-testid="archived-chats-control"]'),
    ).toBeNull();
    expect(
      diff?.querySelector('[data-testid="archived-chats-control"]'),
    ).not.toBeNull();
  });

  it('moves the tab-strip control out of a collapsed branch', () => {
    const store = usePanelLayoutStore.getState();
    store.maximizeGroup(KEY, 'group-diff', false);
    const layout = usePanelLayoutStore.getState().layouts[KEY];
    if (layout === undefined) throw new Error('layout missing');
    // The chat group sits in a collapsed branch: its bar hides the group.
    usePanelLayoutStore.setState((state) => ({
      layouts: {
        ...state.layouts,
        [KEY]: {
          ...layout,
          controller: {
            ...layout.controller,
            getCollapsedBranches: (): {
              groupIds: string[];
              element: HTMLElement;
              edge: 'left';
            }[] => [
              {
                groupIds: ['group-chat'],
                element: document.createElement('div'),
                edge: 'left',
              },
            ],
          },
        },
      },
    }));

    const tabStrip = renderGroups('tabStrip');
    expect(
      tabStrip.chat?.querySelector('[data-testid="archived-chats-control"]'),
    ).toBeNull();
    expect(
      tabStrip.diff?.querySelector('[data-testid="archived-chats-control"]'),
    ).not.toBeNull();

    // The header-style control (develop) is unaffected.
    const header = renderGroups('header');
    expect(
      header.chat?.querySelector('[data-testid="archived-chats-control"]'),
    ).not.toBeNull();
  });
});
