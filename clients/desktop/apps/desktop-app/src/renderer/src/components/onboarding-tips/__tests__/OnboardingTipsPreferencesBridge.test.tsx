/** @jest-environment jsdom */
import { act, useEffect } from 'react';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { noteChatCreatedInSession } from '@/stores/chat/created-in-session';
import { registerPendingTabCreation } from '@/stores/chat/pending-tab-creation';
import { createRoot } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import {
  CanopyClientProvider,
  useOnboardingTipsStore,
  type OnboardingTipsStoreState,
} from '@canopy/app-state';
import { notifyHomeTaskSent, type HomeTaskSendEvent } from '../homeSendEvents';
import { OnboardingTipsPreferencesBridge } from '../OnboardingTipsPreferencesBridge';

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: { id: string; type: string }[] } => ({
      projects: [{ id: 'creation-project', type: 'single-repo' }],
    }),
  },
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it.each<{ event: HomeTaskSendEvent; held: boolean; used: boolean }>([
  { event: { kind: 'chat', acceptedTurn: true }, held: false, used: false },
  {
    event: { kind: 'chat', acceptedTurn: true, worktreeChat: true },
    held: false,
    used: true,
  },
  { event: { kind: 'chat', acceptedTurn: false }, held: true, used: false },
  { event: { kind: 'pipeline' }, held: true, used: false },
  {
    event: { kind: 'chat', chatId: 'composer', acceptedTurn: true },
    held: true,
    used: false,
  },
])(
  'handles Home acceptance $event without double-reporting composer sends',
  ({ event, held, used }): void => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let tips: OnboardingTipsStoreState | undefined;
    function Probe(): null {
      const state = useOnboardingTipsStore((value) => value);
      useEffect(() => {
        tips = state;
      }, [state]);
      return null;
    }
    const client = {
      capabilities: { onboardingTips: true },
      query: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn(),
    } as unknown as CanopyClient;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { onPreferencesSynced: (): (() => void) => () => undefined },
    });
    try {
      act(() =>
        root.render(
          <CanopyClientProvider client={client}>
            <Probe />
            <OnboardingTipsPreferencesBridge />
          </CanopyClientProvider>,
        ),
      );
      act(() => tips?.holdForNotice('automatic'));
      act(() => notifyHomeTaskSent(event));
      expect(tips?.held).toBe(held);
      expect(tips?.worktreeHistory === 'used').toBe(used);
    } finally {
      act(() => root.unmount());
    }
  },
);

it('replays canonical creation outcomes, excluding failed drafts, file tabs and standalone chats', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  let tips: OnboardingTipsStoreState | undefined;
  function Probe(): null {
    const state = useOnboardingTipsStore((value) => value);
    useEffect(() => {
      tips = state;
    }, [state]);
    return null;
  }
  const client = {
    capabilities: { onboardingTips: true },
    query: jest.fn(
      (name: string): Promise<unknown> =>
        Promise.resolve(
          name === 'session.snapshot'
            ? {
                chatSummaries: [
                  {
                    localId: 'confirmed-first',
                    chatId: 'confirmed-first',
                    scope: 'worktree',
                    workspaceLocalId: 'creation-project',
                    worktreeLocalId: 'creation-worktree',
                    title: 'Empty retry',
                    messageCount: 0,
                  },
                ],
              }
            : { dismissed: {} },
        ),
    ),
    command: jest.fn(),
    subscribe: jest.fn((): (() => void) => () => undefined),
  } as unknown as CanopyClient;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { onPreferencesSynced: (): (() => void) => () => undefined },
  });
  noteChatCreatedInSession('rejected-first');
  registerPendingTabCreation(
    'creation-project',
    'creation-worktree',
    'rejected-first',
    Promise.resolve('rejected'),
  );
  noteChatCreatedInSession('standalone-first');
  registerPendingTabCreation(
    STANDALONE_CHAT_PROJECT_ID,
    'standalone',
    'standalone-first',
    Promise.resolve('accepted'),
  );
  noteChatCreatedInSession('pipeline-editor');
  registerPendingTabCreation(
    'pipeline-editor',
    'pipeline-editor',
    'pipeline-editor',
    Promise.resolve('accepted'),
  );
  // File tabs and restored chats are not constructed by createEmptyTab.
  registerPendingTabCreation(
    'creation-project',
    'creation-worktree',
    'file-or-restored',
    Promise.resolve('accepted'),
  );
  noteChatCreatedInSession('confirmed-first');
  registerPendingTabCreation(
    'creation-project',
    'creation-worktree',
    'confirmed-first',
    Promise.resolve('accepted'),
  );
  try {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={client}>
          <Probe />
          <OnboardingTipsPreferencesBridge />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      tips?.load();
      await Promise.resolve();
    });
    await act(async () => {
      tips?.arrive('creation-composer', ['worktree-chat'], {
        key: 'confirmed-first',
        worktreeChat: {
          chatId: 'confirmed-first',
          workspaceLocalId: 'creation-project',
          worktreeLocalId: 'creation-worktree',
          transcript: 'empty',
        },
      });
      await Promise.resolve();
    });
    expect(tips?.worktreeHistory).toBe('fresh');
    expect(tips?.current?.tipId).toBe('worktree-chat');
    await act(async () => {
      noteChatCreatedInSession('confirmed-second');
      registerPendingTabCreation(
        'creation-project',
        'creation-worktree',
        'confirmed-second',
        Promise.resolve('accepted'),
      );
      await Promise.resolve();
    });
    expect(tips?.worktreeHistory).toBe('used');
    expect(tips?.current).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
