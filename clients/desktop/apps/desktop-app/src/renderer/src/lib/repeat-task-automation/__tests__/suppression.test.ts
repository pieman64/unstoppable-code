/**
 * @jest-environment jsdom
 */
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  AutomationAction,
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { isCoveredByExistingAutomation } from '../suppression';

function makeActivity(
  action: AutomationAction,
  id = 'activity-1',
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Daily digest',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function installAutomationList(
  list: () => Promise<AutomationsListResponse>,
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { automations: { list } },
  });
}

describe('repeat task automation suppression', () => {
  beforeEach(() => {
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
    });
  });

  it('suppresses a similar prompt with the same worktree destination', async () => {
    useAutomationsStore.setState({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(true);
  });

  it('ignores a turned-off automation with a similar prompt', async () => {
    useAutomationsStore.setState({
      activities: [
        {
          ...makeActivity({
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Summarize the billing failures Monday',
          }),
          enabled: false,
        },
      ],
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(false);
  });

  it('checks standalone prompt destinations and ignores unrelated destinations', async () => {
    useAutomationsStore.setState({
      activities: [
        makeActivity({
          type: 'standalone_prompt',
          chatProjectId: 'cowork-project',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
    });

    await expect(
      isCoveredByExistingAutomation('cowork-project', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(true);
    await expect(
      isCoveredByExistingAutomation('different-project', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(false);
  });

  it('does not suppress a dissimilar prompt or an App Advisor activity elsewhere', async () => {
    useAutomationsStore.setState({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Update the dependency lockfile and run tests',
        }),
        makeActivity(
          {
            type: 'app_advisor_prompt',
            prompt: 'Summarize the billing failures Monday',
          },
          'advisor-activity',
        ),
      ],
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(false);
    await expect(
      isCoveredByExistingAutomation(APP_ADVISOR_PROJECT_ID, [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(true);
  });

  it('hydrates a cold store with one request before checking activities', async () => {
    const activity = makeActivity({
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      prompt: 'Summarize the billing failures Monday',
    });
    const list = jest.fn<Promise<AutomationsListResponse>, []>();
    list.mockResolvedValue({ activities: [activity], recentRuns: [] });
    installAutomationList(list);
    useAutomationsStore.setState({
      activities: [],
      loading: false,
      hydrated: false,
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('joins an already loading snapshot instead of starting another request', async () => {
    let finish: (response: AutomationsListResponse) => void = () => undefined;
    const list = jest.fn<Promise<AutomationsListResponse>, []>();
    list.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    installAutomationList(list);
    useAutomationsStore.setState({
      activities: [],
      loading: false,
      hydrated: false,
    });

    const firstHydration = useAutomationsStore.getState().hydrate();
    const coverage = isCoveredByExistingAutomation('workspace-1', [
      'billing',
      'failures',
      'summarize',
    ]);
    finish({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
      recentRuns: [],
    });

    await expect(coverage).resolves.toBe(true);
    await firstHydration;
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('waits for a refresh in flight instead of reading the stale list', async () => {
    let finish: (response: AutomationsListResponse) => void = () => undefined;
    const response = new Promise<AutomationsListResponse>((resolve) => {
      finish = resolve;
    });
    installAutomationList(() => response);
    useAutomationsStore.setState({ activities: [], hydrated: true });

    const refresh = useAutomationsStore.getState().hydrate();
    const coverage = isCoveredByExistingAutomation('workspace-1', [
      'billing',
      'failures',
      'summarize',
    ]);
    finish({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
      recentRuns: [],
    });

    await expect(coverage).resolves.toBe(true);
    await refresh;
  });

  it('follows a load that replaces the one it was waiting for', async () => {
    const finishers: Array<(response: AutomationsListResponse) => void> = [];
    installAutomationList(
      () =>
        new Promise<AutomationsListResponse>((resolve) => {
          finishers.push(resolve);
        }),
    );
    useAutomationsStore.setState({
      activities: [],
      loading: false,
      hydrated: false,
    });

    const coverage = isCoveredByExistingAutomation('workspace-1', [
      'billing',
      'failures',
      'summarize',
    ]);
    const replacement = useAutomationsStore.getState().hydrate();
    finishers[0]?.({ activities: [], recentRuns: [] });
    finishers[1]?.({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
      recentRuns: [],
    });

    await expect(coverage).resolves.toBe(true);
    await replacement;
    expect(finishers).toHaveLength(2);
  });

  it('does not trust the earlier list when the refresh it waited for fails', async () => {
    const list = jest.fn<Promise<AutomationsListResponse>, []>();
    list.mockRejectedValue(new Error('automation service unavailable'));
    installAutomationList(list);
    useAutomationsStore.setState({
      activities: [
        makeActivity({
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Summarize the billing failures Monday',
        }),
      ],
      loading: true,
      hydrated: true,
      error: null,
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('fails open when automation hydration fails', async () => {
    const list = jest.fn<Promise<AutomationsListResponse>, []>();
    list.mockRejectedValue(new Error('automation service unavailable'));
    installAutomationList(list);
    useAutomationsStore.setState({
      activities: [],
      loading: false,
      hydrated: false,
    });

    await expect(
      isCoveredByExistingAutomation('workspace-1', [
        'billing',
        'failures',
        'summarize',
      ]),
    ).resolves.toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
