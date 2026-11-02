/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationsListResponse,
  ListUsageLimitedIdleSessionsRequest,
  ScheduledActivity,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { buttonClassName } from '@canopy/ui-shared/components';
import { HomeContinueSection } from '../HomeContinueSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

function chat(
  chatId: string,
  provider: 'claude' | 'codex',
): UsageLimitedSessionGroup {
  return {
    groupId: 'ws',
    groupKind: 'workspace',
    workspaceId: 'ws',
    workspaceName: 'Workspace',
    sessions: [
      {
        kind: 'chat',
        projectId: 'ws',
        worktreeId: 'wt',
        chatId,
        provider,
        chatTitle: chatId,
        detectedAt: 1,
        worktreeName: 'main',
      },
    ],
  };
}

function scheduledResume(chatId: string): ScheduledActivity {
  const nextRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    version: 1,
    id: `resume-${chatId}`,
    name: 'Resume',
    enabled: true,
    schedule: { kind: 'one_time', runAt: nextRunAt, timezone: 'local' },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'ws',
      worktreeId: 'wt',
      chatId,
      prompt: 'continue',
      purpose: 'usage_limit_resume',
    },
    createdAt: nextRunAt,
    updatedAt: nextRunAt,
    nextRunAt,
    failureCount: 0,
  };
}

const listSessionsMock = jest.fn<
  Promise<UsageLimitedSessionGroup[]>,
  [ListUsageLimitedIdleSessionsRequest]
>();

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function banner(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="home-interrupted-sessions-banner"]',
  );
}

describe('HomeContinueSection interrupted sessions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    listSessionsMock
      .mockReset()
      .mockResolvedValue([chat('c1', 'claude'), chat('c2', 'codex')]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: listSessionsMock },
    });
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      hydrated: false,
      loading: false,
      error: null,
    });
    jest.mocked(useCurrentUiStateReporter).mockClear();
    useUsageLimitResumePromptStore.getState().close();
    useHomeInterruptedSessionsBannerStore.setState({
      dismissedSignature: null,
    });
    useObservabilityStore.setState({ usage: { updatedAt: '', providers: [] } });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(active = true, isPageVariant = false): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, {
          interruptedActive: active,
          isPageVariant,
        }),
      );
      await flushPromises();
    });
  }

  async function refocus(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    });
  }

  it('lists every interrupted session regardless of provider or reason', async () => {
    await render();
    expect(listSessionsMock).toHaveBeenCalledWith({});
    expect(banner()?.textContent).toContain('Resume 2 interrupted chats');
  });

  it('renders nothing when no sessions are interrupted', async () => {
    listSessionsMock.mockResolvedValue([]);
    await render();
    expect(banner()).toBeNull();
  });

  it('does not fetch while inactive', async () => {
    await render(false);
    expect(listSessionsMock).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('opens the shared resume modal for all providers', async () => {
    await render();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-interrupted-sessions-resume"]',
        )
        ?.click();
    });
    expect(useUsageLimitResumePromptStore.getState()).toMatchObject({
      isOpen: true,
      provider: null,
      origin: 'home',
    });
  });

  describe('with a provider waiting for its usage reset', () => {
    const codexBlocked = {
      updatedAt: '',
      providers: [
        {
          provider: 'codex' as const,
          authState: 'authenticated' as const,
          hasRemainingLimits: false,
          rateLimits: [
            {
              limitId: 'codex',
              secondary: {
                usedPercent: 100,
                resetsAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
                windowDurationMins: 7 * 24 * 60,
              },
            },
          ],
        },
      ],
    };

    function resumeRow(): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        '[data-testid="home-interrupted-sessions-resume"]',
      );
    }

    it('counts waiting sessions apart from those ready now', async () => {
      listSessionsMock.mockResolvedValue([
        chat('c1', 'claude'),
        chat('c2', 'claude'),
        chat('x1', 'codex'),
      ]);
      useObservabilityStore.setState({ usage: codexBlocked });
      await render();
      const details = document.querySelector(
        '[data-testid="home-interrupted-sessions-details"]',
      );
      expect(details?.textContent).toMatch(
        /^Resume 2 chats · 1 waiting for Codex reset \(.+\)$/,
      );
      expect(resumeRow()?.getAttribute('aria-label')).toBe(
        details?.textContent,
      );
    });

    it('keeps an all-waiting row so the user can review and schedule', async () => {
      listSessionsMock.mockResolvedValue([chat('x1', 'codex')]);
      useObservabilityStore.setState({ usage: codexBlocked });
      await render();
      // A single entry is named; waiting never claims it can resume now.
      expect(
        document.querySelector(
          '[data-testid="home-interrupted-sessions-details"]',
        )?.textContent,
      ).toMatch(
        /^x1 waiting for Codex reset \(.+\) Interrupted · main · Workspace$/,
      );
      expect(resumeRow()?.disabled).toBe(false);
    });

    it('returns after dismissal once readiness changes', async () => {
      listSessionsMock.mockResolvedValue([
        chat('c1', 'claude'),
        chat('x1', 'codex'),
      ]);
      useObservabilityStore.setState({ usage: codexBlocked });
      await render();
      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-interrupted-sessions-dismiss"]',
          )
          ?.click();
      });
      expect(banner()).toBeNull();
      await act(async () => {
        useObservabilityStore.setState({
          usage: { updatedAt: '', providers: [] },
        });
        await flushPromises();
      });
      expect(banner()?.textContent).toContain('Resume 2 interrupted chats');
    });
  });

  it('dismisses until the interrupted set changes', async () => {
    await render();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-interrupted-sessions-dismiss"]',
        )
        ?.click();
    });
    expect(banner()).toBeNull();

    // Same set again: stays dismissed.
    await refocus();
    expect(banner()).toBeNull();

    // A new interruption changes the set: the banner returns.
    listSessionsMock.mockResolvedValue([
      chat('c1', 'claude'),
      chat('c2', 'codex'),
      chat('c3', 'claude'),
    ]);
    await refocus();
    expect(banner()?.textContent).toContain('Resume 3 interrupted chats');
  });

  it('refreshes after the resume modal closes and hides when nothing is left', async () => {
    await render();
    expect(banner()).not.toBeNull();
    await act(async () => {
      useUsageLimitResumePromptStore.getState().open(null, 'home');
      await flushPromises();
    });
    listSessionsMock.mockResolvedValue([]);
    await act(async () => {
      useUsageLimitResumePromptStore.getState().close();
      await flushPromises();
    });
    expect(banner()).toBeNull();
  });

  it('keeps row group-hover chrome and uses a circular dismiss hover', async () => {
    await render();
    const row = banner();
    const resume = document.querySelector<HTMLButtonElement>(
      '[data-testid="home-interrupted-sessions-resume"]',
    );
    const dismiss = document.querySelector<HTMLButtonElement>(
      '[data-testid="home-interrupted-sessions-dismiss"]',
    );
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining(['group', 'rounded-full']),
    );
    expect(resume?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'group-hover:bg-subtle',
        'group-hover:fg-primary',
      ]),
    );
    expect(resume?.className.split(' ')).not.toContain('hover:bg-subtle');
    expect(dismiss?.className.split(' ')).toEqual(
      expect.arrayContaining(
        buttonClassName({
          variant: 'ghost-overlay',
          size: 'compact',
          iconOnly: true,
        })
          .split(' ')
          .filter(Boolean),
      ),
    );
    expect(dismiss?.className.split(' ')).not.toContain('rounded-md');
    expect(dismiss?.className.split(' ')).not.toContain('hover:bg-secondary');
  });

  describe('scheduled usage-limit resumes (CAN-4970)', () => {
    let automations: ScheduledActivity[];
    let changed: ((snapshot: AutomationsListResponse) => void) | undefined;

    beforeEach(() => {
      automations = [];
      changed = undefined;
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          listUsageLimitedIdleSessions: listSessionsMock,
          automations: {
            list: (): Promise<AutomationsListResponse> =>
              Promise.resolve({ activities: automations, recentRuns: [] }),
            onChanged: (
              listener: (snapshot: AutomationsListResponse) => void,
            ): (() => void) => {
              changed = listener;
              return (): void => undefined;
            },
          },
        },
      });
    });

    async function emit(activities: ScheduledActivity[]): Promise<void> {
      automations = activities;
      await act(async () => {
        changed?.({ activities, recentRuns: [] });
        await flushPromises();
      });
    }

    function latestAdvisorReport(): unknown {
      return jest
        .mocked(useCurrentUiStateReporter)
        .mock.calls.filter(
          ([slice]) => slice === 'home.interruptedSessionsBanner',
        )
        .at(-1)?.[1];
    }

    it('hides the row when its only interrupted chat has a scheduled resume', async () => {
      listSessionsMock.mockResolvedValue([chat('c1', 'claude')]);
      automations = [scheduledResume('c1')];
      await render(true, true);
      expect(banner()).toBeNull();
      expect(latestAdvisorReport()).toEqual({
        visible: false,
        count: 0,
        readyCount: 0,
        waitingCount: 0,
      });
    });

    it('counts only unscheduled chats, and App Advisor agrees', async () => {
      automations = [scheduledResume('c1')];
      await render(true, true);
      expect(banner()?.textContent).toContain('Resume c2');
      expect(latestAdvisorReport()).toEqual({
        visible: true,
        count: 1,
        readyCount: 1,
        waitingCount: 0,
      });

      await emit([]);
      expect(banner()?.textContent).toContain('Resume 2 interrupted chats');
      expect(latestAdvisorReport()).toEqual({
        visible: true,
        count: 2,
        readyCount: 2,
        waitingCount: 0,
      });
      expect(listSessionsMock).toHaveBeenCalledTimes(1);
    });

    it('restores a dismissed row when scheduling changes the remaining set', async () => {
      await render();
      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="home-interrupted-sessions-dismiss"]',
          )
          ?.click();
      });
      expect(banner()).toBeNull();

      await emit([scheduledResume('c1')]);
      expect(banner()?.textContent).toContain('Resume c2');
    });
  });
});
