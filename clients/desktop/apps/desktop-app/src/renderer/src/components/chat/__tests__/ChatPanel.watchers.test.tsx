/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import { watchersForSubscriberDestination } from '@/components/watchers/watcherFilters';

// The worktree chat surface is split across WorktreeChatSurface (the
// per-tab panel surface), its state hook, and the extracted ChatContent;
// source assertions cover the whole set.
const CHAT_PANEL_SOURCE = [
  'WorktreeChatSurface.tsx',
  'useWorktreeChatSurfaceState.ts',
  'ChatContent.tsx',
]
  .map((file) => readFileSync(join(__dirname, '..', file), 'utf-8'))
  .join('\n');
const CHAT_INPUT_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatInput.tsx'),
  'utf-8',
);
const TURN_GROUP_RENDERER_SOURCE = readFileSync(
  join(__dirname, '..', 'TurnGroupRenderer.tsx'),
  'utf-8',
);

function chatWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? 'chat-watcher-1',
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'Chat watcher',
    target: overrides.target ?? {
      kind: 'worktree_chat',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    },
    destination: overrides.destination ?? {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    createdAt: overrides.createdAt ?? '2026-05-27T00:00:00.000Z',
  };
}

describe('Chat watcher owner indicator placement', () => {
  it('hydrates watcher data in the composer and filters by subscriber destination, not watched target', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      'useAppAdvisorWatchersStore.getState().subscribeBridge()',
    );
    expect(CHAT_INPUT_SOURCE).toContain('void watchersStore.hydrate();');
    expect(CHAT_INPUT_SOURCE).toContain(
      'watchersForSubscriberDestination(s.watchers, watcherDestination)',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'projectId: selectedWorktree.projectId',
    );
    expect(CHAT_INPUT_SOURCE).toContain(
      'worktreeId: selectedWorktree.worktreeId',
    );
    expect(CHAT_INPUT_SOURCE).toContain('chatId: tabId');

    expect(
      watchersForSubscriberDestination(
        [
          chatWatcher({
            id: 'destination-match',
            destination: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
          }),
          chatWatcher({
            id: 'target-only',
            target: {
              kind: 'worktree_chat',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
            destination: {
              projectId: 'other-project',
              worktreeId: 'other-worktree',
              chatId: 'other-chat',
            },
          }),
          chatWatcher({
            id: 'fired',
            status: 'fired',
            destination: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
          }),
        ],
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      ).map((watcher) => watcher.id),
    ).toEqual(['destination-match']);
  });

  it('includes a grouped GitHub watcher owned by the composer destination', () => {
    const destination = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const githubTarget: AppAdvisorWatcherSummary['target'] = {
      kind: 'github_workflow_runs',
      items: [
        {
          kind: 'workflow_run',
          repository: 'acme/api',
          runId: '1',
        },
      ],
      notifyOn: {
        statuses: [],
        conclusions: ['failure', 'success'],
        jobConclusions: [],
      },
      display: {
        repositories: ['acme/api'],
        sample: [{ repository: 'acme/api', runId: '1', runAttempt: 1 }],
      },
    };
    const githubWatcher: AppAdvisorWatcherSummary = {
      id: 'github-watcher',
      trigger: 'github_workflow_runs_changed',
      status: 'active',
      label: 'CI watcher',
      target: githubTarget,
      destination,
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    // The composer surfaces every watcher whose destination is this chat,
    // regardless of target kind — the GitHub target needs display support, not
    // a new chat filter.
    expect(
      watchersForSubscriberDestination(
        [githubWatcher, chatWatcher({ id: 'chat-target' })],
        destination,
      ).map((watcher) => watcher.id),
    ).toEqual(['github-watcher']);
  });

  it('renders the watchers chip beside + like the Plan chip', () => {
    expect(CHAT_INPUT_SOURCE).toContain('<WatcherManagementButton');
    expect(CHAT_INPUT_SOURCE).toContain(
      'dataTestId={`chat-input-watchers-${watcherDestination.chatId}`}',
    );
    expect(CHAT_INPUT_SOURCE).toContain('icon="bigtop"');
    expect(CHAT_INPUT_SOURCE).toContain('tooltipTitle="WATCHING"');
    expect(CHAT_INPUT_SOURCE).toContain('modalTitle="Chat watchers"');
    expect(CHAT_INPUT_SOURCE).toContain(
      'modalEmptyMessage="No active watchers for this chat."',
    );
    expect(CHAT_INPUT_SOURCE).toContain('ariaLabel="Manage chat watchers"');
    expect(CHAT_INPUT_SOURCE).toMatch(
      /watchersSlot=\{[\s\S]{0,200}<WatcherManagementButton[\s\S]{0,500}appearance="composer-chip"/,
    );
    // No longer pinned over the text, so the box keeps its one line.
    expect(CHAT_INPUT_SOURCE).not.toContain(
      'className="absolute right-2 top-2 z-30"',
    );
    expect(CHAT_INPUT_SOURCE).not.toContain('chatInputWatchers.length > 0),');
  });

  it('keeps the chat panel floating area reserved for the mode toggle', () => {
    const floatingCluster =
      'absolute right-3 bottom-2 z-20 flex items-center gap-2';
    expect(
      CHAT_PANEL_SOURCE.match(new RegExp(floatingCluster, 'g')),
    ).toHaveLength(1);
    expect(CHAT_PANEL_SOURCE).not.toContain('<WatcherManagementButton');
    expect(CHAT_PANEL_SOURCE).not.toContain('chat-watchers-');

    for (const cluster of CHAT_PANEL_SOURCE.split(floatingCluster).slice(1)) {
      const toggleIdx = cluster.indexOf('<ChatInterfaceModeToggle');
      if (toggleIdx !== -1) {
        expect(toggleIdx).toBeGreaterThan(-1);
      }
    }
  });

  it('keeps App Advisor watcher ownership locked to the exact subscribing tab', () => {
    expect(CHAT_INPUT_SOURCE).not.toContain('AppAdvisorWatcherIndicator');
    expect(CHAT_INPUT_SOURCE).toContain(
      'watchersForSubscriberDestination(s.watchers, watcherDestination)',
    );
    expect(
      watchersForSubscriberDestination(
        [
          chatWatcher({
            id: 'active-advisor-tab',
            destination: {
              projectId: APP_ADVISOR_PROJECT_ID,
              worktreeId: APP_ADVISOR_WORKTREE_ID,
              chatId: 'advisor-tab-a',
            },
          }),
          chatWatcher({
            id: 'other-advisor-tab',
            destination: {
              projectId: APP_ADVISOR_PROJECT_ID,
              worktreeId: APP_ADVISOR_WORKTREE_ID,
              chatId: 'advisor-tab-b',
            },
          }),
        ],
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'advisor-tab-a',
        },
      ).map((watcher) => watcher.id),
    ).toEqual(['active-advisor-tab']);
    expect(CHAT_INPUT_SOURCE).not.toContain('watcherScopeIsAppAdvisor');
    expect(CHAT_INPUT_SOURCE).not.toContain(
      'watcher.destination.projectId === APP_ADVISOR_PROJECT_ID',
    );
  });

  it('excludes synthetic chat scopes from active-turn watcher controls', () => {
    expect(TURN_GROUP_RENDERER_SOURCE).toContain('<ChatWatcherButton');
    // The standalone/cowork scope is excluded via the isCoworkChatTarget
    // capability helper (Phase 2 sentinel retirement) rather than a literal
    // STANDALONE_CHAT_PROJECT_ID comparison.
    expect(TURN_GROUP_RENDERER_SOURCE).toContain(
      '!isCoworkChatTarget(selectedWorktreeProjectId)',
    );
    expect(TURN_GROUP_RENDERER_SOURCE).toContain(
      'selectedWorktreeProjectId !== APP_ADVISOR_PROJECT_ID',
    );
    expect(TURN_GROUP_RENDERER_SOURCE).toContain(
      'selectedWorktreeProjectId !== PIPELINE_EDITOR_PROJECT_ID',
    );
    expect(TURN_GROUP_RENDERER_SOURCE).toContain(
      'selectedWorktreeProjectId !== PLAN_EXPLORE_CHAT_PROJECT_ID',
    );
  });
});
