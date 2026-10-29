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
  ListUsageLimitedIdleSessionsRequest,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
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
    useUsageLimitResumePromptStore.getState().close();
    useHomeInterruptedSessionsBannerStore.setState({
      dismissedSignature: null,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(active = true): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, { interruptedActive: active }),
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
    expect(banner()?.textContent).toContain('Resume 2 interrupted sessions');
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
    expect(banner()?.textContent).toContain('Resume 3 interrupted sessions');
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
      expect.arrayContaining(['rounded-full', 'hover:bg-muted', 'h-7', 'w-7']),
    );
    expect(dismiss?.className.split(' ')).not.toContain('rounded-md');
    expect(dismiss?.className.split(' ')).not.toContain('hover:bg-secondary');
  });
});
