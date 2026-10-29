/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useWatcherRecipientGroups } from '../useWatcherRecipientGroups';
import type { WatcherRecipientGroup } from '../WatcherRecipientPicker';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const APP_ADVISOR_KEY = `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`;

interface HookProbe {
  current: WatcherRecipientGroup[] | null;
}

function makeChatTab(id: string, overrides?: Partial<ChatTab>): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function HookHarness({ probe }: { probe: HookProbe }): JSX.Element {
  probe.current = useWatcherRecipientGroups({
    worktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
  });
  return <></>;
}

function renderHookHarness(): {
  probe: HookProbe;
  cleanup: () => void;
} {
  const probe: HookProbe = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(<HookHarness probe={probe} />);
  });

  return {
    probe,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('useWatcherRecipientGroups', () => {
  afterEach(() => {
    useChatStore.setState(useChatStore.getInitialState());
  });

  it('excludes file and read-only worktree tabs from recipient options', () => {
    useChatStore.setState({
      worktreeChats: {
        [APP_ADVISOR_KEY]: {
          activeTabId: 'advisor-chat',
          tabs: [makeChatTab('advisor-chat', { title: 'Advisor Chat' })],
        },
        [WORKTREE_KEY]: {
          activeTabId: 'file-tab',
          tabs: [
            makeChatTab('chat-ok', { title: 'Writable chat' }),
            makeChatTab('file-tab', {
              kind: 'file',
              title: 'notes.md',
              filePath: '/repo/notes.md',
            }),
            makeChatTab('read-only-chat', {
              title: 'Read-only chat',
              readOnly: true,
            }),
            makeChatTab('chat-other', { title: 'Other writable chat' }),
          ],
        },
      },
    });

    const { probe, cleanup } = renderHookHarness();
    try {
      if (!probe.current) {
        throw new Error('Expected watcher recipient groups to be captured');
      }

      const worktreeGroup = probe.current.find(
        (group) => group.key === 'worktree',
      );
      expect(
        worktreeGroup?.options.map((option) => option.destination.chatId),
      ).toEqual(['chat-ok', 'chat-other']);
      expect(
        worktreeGroup?.options.some(
          (option) => option.preferredDefault === true,
        ),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });
});
