/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PendingSkillShareNudge,
  ResolveSkillShareNudgeRequest,
  SkillShareNudgeOrigin,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { ChatShareData } from '@/hooks/useChatShareData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let mockData: ChatShareData;
const mockUseChatShareData = jest.fn<ChatShareData, [active: boolean]>(
  (): ChatShareData => mockData,
);
jest.mock('@/hooks/useChatShareData', () => ({
  useChatShareData: (active: boolean): ChatShareData => {
    mockUseChatShareData(active);
    return mockData;
  },
}));

import { SkillShareNudgeBanner } from '../SkillShareNudgeBanner';
import {
  notifyShareCompleted,
  useShareRequestStore,
} from '@/stores/shareRequestStore';

const ORIGIN = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const SKILL_TARGET = {
  kind: 'skill',
  sourceId: 'custom:app',
  name: 'release-notes',
} as const;
const PLUGIN_TARGET = {
  kind: 'plugin',
  marketplaceId: 'acme-market',
  pluginName: 'release-tools',
} as const;

function skill(
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo {
  return {
    name: 'release-notes',
    sourceId: 'custom:app',
    description: '',
    source: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
    ...overrides,
  };
}

function data(overrides: Partial<ChatShareData> = {}): ChatShareData {
  return {
    installedSkills: [skill()],
    marketplaces: [
      {
        id: 'acme-market',
        name: 'Acme',
        sourceType: 'github',
        sourceUrl: 'https://github.com/acme/plugins',
        plugins: [
          {
            name: 'release-tools',
            displayName: 'Release tools',
            facets: { claude: {} },
          },
        ],
      },
    ] as unknown as ChatShareData['marketplaces'],
    localSettled: true,
    skillsSettled: true,
    marketplacesSettled: true,
    skillAudienceReady: true,
    sharedPlugins: [],
    accountId: 'me',
    inventoryEntries: null,
    mentionIndex: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

describe('SkillShareNudgeBanner', () => {
  let container: HTMLElement;
  let root: Root;
  let pendingByChat: Record<string, PendingSkillShareNudge | null>;
  let changed: ((origin: SkillShareNudgeOrigin) => void) | null;
  let composerVisible: boolean;
  const getPending = jest.fn((origin: SkillShareNudgeOrigin) =>
    Promise.resolve({
      success: true,
      data: pendingByChat[origin.chatId] ?? null,
    }),
  );
  const resolve = jest.fn<
    Promise<{ success: boolean; data: boolean }>,
    [ResolveSkillShareNudgeRequest]
  >(() => Promise.resolve({ success: true, data: true }));
  let unregisterHost: () => void;

  async function render(
    props: { chatId?: string; streaming?: boolean } = {},
  ): Promise<void> {
    act(() => {
      root.render(
        <SkillShareNudgeBanner
          projectId={ORIGIN.projectId}
          worktreeId={ORIGIN.worktreeId}
          chatId={props.chatId ?? ORIGIN.chatId}
          streaming={props.streaming ?? false}
          isComposerVisible={() => composerVisible}
        />,
      );
    });
    await flush();
  }

  const banner = (): HTMLElement | null =>
    document.querySelector('[data-testid="skill-share-nudge-banner"]');
  const resolutions = (): string[] =>
    resolve.mock.calls.map(([request]) => request.resolution);

  beforeEach(() => {
    mockData = data();
    pendingByChat = {
      chat: { id: 'pending-1', target: SKILL_TARGET, state: 'pending' },
    };
    changed = null;
    composerVisible = true;
    getPending.mockClear();
    resolve.mockReset().mockResolvedValue({ success: true, data: true });
    mockUseChatShareData.mockClear();
    Object.assign(window, {
      skillShareNudge: {
        getPending,
        resolve,
        onChanged: (callback: (origin: SkillShareNudgeOrigin) => void) => {
          changed = callback;
          return (): void => {
            changed = null;
          };
        },
      },
    });
    useShareRequestStore.setState({
      hostCount: 0,
      request: null,
      nudgeResolutions: {},
    });
    unregisterHost = useShareRequestStore.getState().registerHost();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregisterHost();
    jest.useRealTimers();
  });

  it('shows a confirmed-unshared skill and reports shown exactly once', async () => {
    await render();
    expect(banner()?.textContent).toContain('You use release-notes often');
    expect(banner()?.textContent).toContain(
      'Share it so others can use it too.',
    );
    expect(banner()?.getAttribute('data-share-kind')).toBe('skill');
    expect(resolutions()).toEqual(['shown']);
    expect(resolve.mock.calls[0]?.[0]).toEqual({
      ...ORIGIN,
      pendingId: 'pending-1',
      target: SKILL_TARGET,
      resolution: 'shown',
    });

    // Main confirms the state; the banner stays and is not reported again.
    pendingByChat.chat = {
      id: 'pending-1',
      target: SKILL_TARGET,
      state: 'shown',
    };
    act(() => changed?.(ORIGIN));
    await flush();
    await render();
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown']);
  });

  it('uses the plugin copy and display name for a plugin target', async () => {
    pendingByChat.chat = {
      id: 'pending-2',
      target: PLUGIN_TARGET,
      state: 'pending',
    };
    await render();
    expect(banner()?.textContent).toContain('You use Release tools often');
    expect(banner()?.textContent).toContain(
      'Share the plugin so others can use its skills too.',
    );
    expect(banner()?.getAttribute('data-share-kind')).toBe('plugin');
  });

  it('retains a skill suggestion until authentication resolves', async () => {
    mockData = data({ accountId: null });
    await render();
    expect(banner()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    mockData = data();
    await render();
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown']);
  });

  it('ignores a stale pending read after a newer replacement arrives', async () => {
    let release: (value: {
      success: boolean;
      data: PendingSkillShareNudge | null;
    }) => void = () => {};
    getPending.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    await render();
    pendingByChat.chat = {
      id: 'replacement',
      target: PLUGIN_TARGET,
      state: 'pending',
    };
    act(() => changed?.(ORIGIN));
    await flush();
    expect(banner()?.getAttribute('data-share-kind')).toBe('plugin');
    act(() => {
      release({
        success: true,
        data: { id: 'old', target: SKILL_TARGET, state: 'pending' },
      });
    });
    await flush();
    expect(banner()?.getAttribute('data-share-kind')).toBe('plugin');
    expect(
      resolve.mock.calls.some(([request]) => request.pendingId === 'old'),
    ).toBe(false);
  });

  it('loads share data only once there is a pending target', async () => {
    pendingByChat.chat = null;
    await render();
    expect(banner()).toBeNull();
    expect(mockUseChatShareData.mock.calls.every(([active]) => !active)).toBe(
      true,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('stays hidden and unspent while data or audience is unknown, then appears without another use', async () => {
    pendingByChat.chat = {
      id: 'pending-2',
      target: PLUGIN_TARGET,
      state: 'pending',
    };
    mockData = data({ sharedPlugins: null, accountId: null });
    await render();
    expect(banner()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    mockData = data();
    await render();
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown']);
  });

  it('reports a confirmed-shared or missing target as ineligible without showing', async () => {
    mockData = data({
      installedSkills: [
        skill({
          remote: {
            remoteId: 'r',
            contentHash: 'h',
            shareScope: 'organization',
            sharedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      ],
    });
    await render();
    expect(banner()).toBeNull();
    expect(resolutions()).toEqual(['ineligible']);

    resolve.mockClear();
    pendingByChat.other = {
      id: 'pending-3',
      target: { ...SKILL_TARGET, name: 'deleted-skill' },
      state: 'pending',
    };
    await render({ chatId: 'other' });
    expect(banner()).toBeNull();
    expect(resolutions()).toEqual(['ineligible']);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'other',
      pendingId: 'pending-3',
    });
  });

  it.each([
    ['while streaming', { streaming: true }, true, true],
    ['on a composer that is not on screen', {}, false, true],
    ['without a share host', {}, true, false],
  ])(
    'does not spend the suggestion %s',
    async (_label, props, visible, host) => {
      composerVisible = visible;
      if (!host) unregisterHost();
      await render(props);
      expect(resolve).not.toHaveBeenCalled();
      if (!visible) return;
      expect(banner()).toBeNull();
    },
  );

  it('appears once streaming ends', async () => {
    await render({ streaming: true });
    expect(banner()).toBeNull();
    await render({ streaming: false });
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown']);
  });

  it('dismisses immediately and persists the dismissal', async () => {
    pendingByChat.chat = {
      id: 'pending-1',
      target: SKILL_TARGET,
      state: 'shown',
    };
    await render();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="skill-share-nudge-banner-dismiss"]',
        )
        ?.click();
    });
    await flush();
    expect(banner()).toBeNull();
    expect(resolutions()).toEqual(['dismissed']);
  });

  it('requests sharing with its origin and keeps the banner until a share completes', async () => {
    pendingByChat.chat = {
      id: 'pending-1',
      target: SKILL_TARGET,
      state: 'shown',
    };
    await render();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="skill-share-nudge-banner-share"]',
        )
        ?.click();
    });
    const request = useShareRequestStore.getState().request;
    expect(request).toMatchObject({
      target: SKILL_TARGET,
      source: 'usage_nudge',
      origin: { ...ORIGIN, pendingId: 'pending-1' },
    });
    expect(request?.ownerDocument).toBe(document);

    // Closing or cancelling the dialog: nothing is recorded, banner stays.
    act(() => {
      if (request) useShareRequestStore.getState().clearRequest(request.id);
    });
    await flush();
    expect(banner()).not.toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    // A completed share, from this or any other entry point.
    act(() => {
      notifyShareCompleted({
        id: 'share-elsewhere',
        target: SKILL_TARGET,
        source: 'activity_panel',
      });
    });
    await flush();
    expect(banner()).toBeNull();
    expect(resolutions()).toEqual(['shared']);
  });

  it('ignores a completed share of a different target', async () => {
    pendingByChat.chat = {
      id: 'pending-1',
      target: SKILL_TARGET,
      state: 'shown',
    };
    await render();
    act(() => {
      notifyShareCompleted({
        id: 'share-other',
        target: PLUGIN_TARGET,
        source: 'activity_panel',
      });
    });
    await flush();
    expect(banner()).not.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never resolves the previous chat target after a chat switch', async () => {
    let releaseFirst: (value: {
      success: boolean;
      data: PendingSkillShareNudge | null;
    }) => void = () => {};
    getPending.mockImplementationOnce(
      () =>
        new Promise((resolvePending) => {
          releaseFirst = resolvePending;
        }),
    );
    pendingByChat.other = null;
    await render();
    await render({ chatId: 'other' });
    // The first chat's answer arrives after the switch and is discarded.
    await act(async () => {
      releaseFirst({
        success: true,
        data: { id: 'pending-1', target: SKILL_TARGET, state: 'pending' },
      });
      await Promise.resolve();
    });
    await flush();
    expect(banner()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['dismissed', 'shared'] as const)(
    'retains a failed %s resolution across remount and retries after four failures',
    async (resolution) => {
      jest.useFakeTimers();
      pendingByChat.chat = {
        id: 'pending-1',
        target: SKILL_TARGET,
        state: 'shown',
      };
      resolve.mockRejectedValue(new Error('write unavailable'));
      await render();
      act(() => {
        if (resolution === 'dismissed') {
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="skill-share-nudge-banner-dismiss"]',
            )
            ?.click();
        } else {
          notifyShareCompleted({
            id: 'completed',
            target: SKILL_TARGET,
            source: 'activity_panel',
          });
        }
      });
      await flush();
      for (let retry = 0; retry < 3; retry += 1) {
        act(() => {
          jest.advanceTimersByTime(60_000);
        });
        await flush();
      }
      expect(resolutions()).toEqual(Array(4).fill(resolution));
      act(() => root.unmount());
      root = createRoot(container);
      await render();
      expect(banner()).toBeNull();
      resolve.mockResolvedValue({ success: true, data: true });
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      await flush();
      expect(resolutions().length).toBeGreaterThan(4);
      expect(banner()).toBeNull();
    },
  );

  it('retries a failed acknowledgement without hiding or re-reporting the banner', async () => {
    jest.useFakeTimers();
    resolve
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue({ success: true, data: true });
    await render();
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown']);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await flush();
    expect(banner()).not.toBeNull();
    expect(resolutions()).toEqual(['shown', 'shown']);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(resolutions()).toEqual(['shown', 'shown']);
  });
});
