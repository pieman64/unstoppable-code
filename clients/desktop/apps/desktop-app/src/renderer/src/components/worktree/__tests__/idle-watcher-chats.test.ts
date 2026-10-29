import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import {
  buildIdleWatcherChatRows,
  hasIdleWatcherChat,
} from '../idle-watcher-chats';

function watcher(
  id: string,
  chatId: string,
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id,
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: `Watcher ${id}`,
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
    destination: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId,
      chatTitle: `Saved ${chatId}`,
    },
    createdAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildIdleWatcherChatRows', () => {
  it('reports only watcher destinations that are outside an active turn', () => {
    const activeTab = {
      id: 'active-chat',
      title: 'Working now',
      providerType: 'claude' as const,
      status: 'streaming' as const,
    };
    const args = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabs: [activeTab],
      watchers: [watcher('active', 'active-chat')],
    };

    expect(hasIdleWatcherChat(args)).toBe(false);
    expect(
      hasIdleWatcherChat({
        ...args,
        watchers: [...args.watchers, watcher('idle', 'background-chat')],
      }),
    ).toBe(true);
  });

  it('does not treat delivery failures as chats waiting for watcher events', () => {
    const args = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabs: undefined,
      watchers: [
        watcher('failed', 'background-chat', {
          status: 'delivery_failed',
        }),
      ],
    };

    expect(hasIdleWatcherChat(args)).toBe(false);
    expect(buildIdleWatcherChatRows(args)).toEqual([]);
  });

  it('groups watchers by idle destination chat and excludes active turns', () => {
    const rows = buildIdleWatcherChatRows({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabs: [
        {
          id: 'idle-chat',
          title: 'Waiting for CI',
          providerType: 'codex',
          status: 'idle',
        },
        {
          id: 'active-chat',
          title: 'Working now',
          providerType: 'claude',
          status: 'streaming',
        },
      ],
      watchers: [
        watcher('one', 'idle-chat'),
        watcher('two', 'idle-chat'),
        watcher('active', 'active-chat'),
        watcher('failed', 'idle-chat', { status: 'delivery_failed' }),
        watcher('terminal', 'idle-chat', { status: 'fired' }),
        watcher('other-worktree', 'idle-chat', {
          destination: {
            projectId: 'project-1',
            worktreeId: 'worktree-2',
            chatId: 'idle-chat',
          },
        }),
      ],
    });

    expect(rows).toEqual([
      {
        chatId: 'idle-chat',
        title: 'Waiting for CI',
        providerType: 'codex',
        preview: '2 watchers registered',
      },
    ]);
  });

  it('uses watcher destination metadata for a lazily hydrated chat', () => {
    const rows = buildIdleWatcherChatRows({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabs: undefined,
      watchers: [watcher('one', 'background-chat')],
    });

    expect(rows).toEqual([
      {
        chatId: 'background-chat',
        title: 'Saved background-chat',
        providerType: undefined,
        preview: '1 watcher registered',
      },
    ]);
  });
});
