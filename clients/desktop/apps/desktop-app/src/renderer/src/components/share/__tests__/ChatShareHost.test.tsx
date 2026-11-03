/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { ChatShareData } from '@/hooks/useChatShareData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const mockShare = jest.fn<void, [string, () => void, (() => void)?]>();
let mockGateModal: JSX.Element | null = null;
jest.mock('@/hooks/useShareAction', () => ({
  useShareAction: (): Record<string, unknown> => ({
    canShare: (): boolean => true,
    share: mockShare,
    shareGateModal: mockGateModal,
  }),
}));

let mockData: ChatShareData;
const mockRefresh = jest.fn();
jest.mock('@/hooks/useChatShareData', () => ({
  useChatShareData: (): ChatShareData => mockData,
  refreshChatShareData: (): void => {
    mockRefresh();
  },
}));

const mockDispatch = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({ ok: true }),
);
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: (request: unknown): Promise<unknown> =>
    mockDispatch(request),
}));

const mockTrack = jest.fn();
jest.mock('@/lib/shareDialogTelemetry', () => ({
  trackShareDialogOpen: (kind: string, source: string): void => {
    mockTrack(kind, source);
  },
}));

const mockAddToast = jest.fn<void, [string, ...unknown[]]>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): Record<string, unknown> => ({ addToast: mockAddToast }),
  },
}));

interface SkillModalProps {
  skill: { sourceId: string; name: string };
  onClose: () => void;
  onShared: () => void;
  onOpenAccountSettings: () => void;
  ownerDocument?: Document;
}
let mockSkillProps: SkillModalProps | null = null;
let mockSkillLoad: Promise<void> | null = null;
jest.mock('@/components/skills/ShareSkillModal', () => ({
  ShareSkillModal: (props: SkillModalProps): JSX.Element => {
    // React Suspense represents an unfinished dialog load by throwing its promise.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (mockSkillLoad) throw mockSkillLoad;
    mockSkillProps = props;
    return <div data-testid="mock-share-skill">{props.skill.name}</div>;
  },
}));

interface PluginModalProps {
  name: string;
  pluginRef: unknown;
  onClose: () => void;
  onShared?: () => void;
  ownerDocument?: Document;
}
let mockPluginProps: PluginModalProps | null = null;
jest.mock('@/components/plugins/SharePluginModal', () => ({
  SharePluginModal: (props: PluginModalProps): JSX.Element => {
    mockPluginProps = props;
    return <div data-testid="mock-share-plugin">{props.name}</div>;
  },
}));

interface PipelineModalProps {
  localPipelineInfo: { id: string; name: string };
  worktree?: { projectId: string; worktreeId: string; repoId?: string };
  onClose: () => void;
  onShared: () => void;
}
let mockPipelineProps: PipelineModalProps | null = null;
jest.mock('@/components/pipeline/SharePipelineModal', () => ({
  SharePipelineModal: (props: PipelineModalProps): JSX.Element => {
    mockPipelineProps = props;
    return (
      <div data-testid="mock-share-pipeline">
        {props.localPipelineInfo.name}
      </div>
    );
  },
}));

const mockLoadPipelineTarget = jest.fn();
jest.mock('@/lib/pipelineDocument', () => ({
  loadPipelineShareTargetDocument: (target: unknown): unknown =>
    mockLoadPipelineTarget(target),
}));

import {
  ChatShareHost,
  SHARE_TARGET_UNRESOLVED_MESSAGE,
} from '../ChatShareHost';
import {
  requestShare,
  subscribeShareCompleted,
  useShareRequestStore,
  type ShareRequest,
} from '@/stores/shareRequestStore';

const SKILL: InstalledSkillInfo = {
  name: 'release-notes',
  sourceId: 'custom:app',
  description: '',
  source: 'custom',
  installedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updateAvailable: false,
  custom: true,
};
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

function data(overrides: Partial<ChatShareData>): ChatShareData {
  return {
    installedSkills: [SKILL],
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
    sharedPlugins: null,
    accountId: null,
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

describe('ChatShareHost', () => {
  let container: HTMLElement;
  let root: Root;
  const loadAccount = jest.fn(() => Promise.resolve(null));
  const resolveNudge = jest.fn(() =>
    Promise.resolve({ success: true, data: true }),
  );

  function render(): void {
    act(() => {
      root.render(<ChatShareHost />);
    });
  }

  /** Runs the gate callback of the nth `share` call, as a sign-in would. */
  async function passGate(
    call = mockShare.mock.calls.length - 1,
  ): Promise<void> {
    const open = mockShare.mock.calls[call]?.[1];
    if (!open) throw new Error('no gated share to pass');
    act(() => open());
    await flush();
  }

  beforeEach(() => {
    mockShare.mockReset();
    mockGateModal = null;
    mockData = data({});
    mockRefresh.mockClear();
    mockDispatch.mockClear();
    mockTrack.mockClear();
    mockAddToast.mockClear();
    mockSkillProps = null;
    mockSkillLoad = null;
    mockPluginProps = null;
    loadAccount.mockClear();
    resolveNudge.mockClear();
    Object.assign(window, {
      api: { loadCanopyCloudAccount: loadAccount },
      skillShareNudge: { resolve: resolveNudge },
    });
    useShareRequestStore.setState({
      hostCount: 0,
      request: null,
      nudgeResolutions: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('registers while mounted and removes itself on unmount', () => {
    render();
    expect(useShareRequestStore.getState().hostCount).toBe(1);
    act(() => root.unmount());
    expect(useShareRequestStore.getState().hostCount).toBe(0);
    root = createRoot(container);
  });

  it('opens the skill dialog only after the gate, and records it once', async () => {
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    expect(mockShare).toHaveBeenCalledTimes(1);
    expect(mockShare.mock.calls[0]?.[0]).toBe('skill');
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
    // A gate alone opens no dialog and records nothing.
    expect(mockTrack).not.toHaveBeenCalled();

    await passGate();
    expect(
      document.querySelector('[data-testid="mock-share-skill"]')?.textContent,
    ).toBe('release-notes');
    expect(mockSkillProps?.skill).toBe(SKILL);
    expect(mockSkillProps?.ownerDocument).toBeUndefined();
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('skill', 'mention_detail');

    // Re-rendering the open dialog does not record it again.
    act(() => {
      mockData = data({ accountId: 'me' });
      root.render(<ChatShareHost />);
    });
    await flush();
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('opens the plugin dialog with the resolved reference and name', async () => {
    render();
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'activity_panel' });
    });
    await flush();
    expect(mockShare.mock.calls[0]?.[0]).toBe('plugin');
    await passGate();
    expect(mockPluginProps?.name).toBe('Release tools');
    expect(mockPluginProps?.pluginRef).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'acme/plugins' },
      plugin_name: 'release-tools',
    });
    expect(mockTrack).toHaveBeenCalledWith('plugin', 'activity_panel');
  });

  describe('pipeline targets', () => {
    const PROJECT_TARGET = {
      kind: 'pipeline',
      source: 'project',
      pipelineId: 'project--ci.yaml',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      relativePath: '.canopy/pipelines/ci.yaml',
    } as const;

    beforeEach(() => {
      mockPipelineProps = null;
      mockLoadPipelineTarget.mockReset();
    });

    it('loads the current pipeline after the gate and opens its dialog', async () => {
      mockLoadPipelineTarget.mockResolvedValue({
        data: {
          info: { id: 'project--ci.yaml', name: 'CI', source: 'project' },
          content: {},
        },
        worktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      render();
      act(() => {
        requestShare(PROJECT_TARGET, { source: 'artifact_card' });
      });
      await flush();
      expect(mockShare.mock.calls[0]?.[0]).toBe('pipeline');
      expect(mockLoadPipelineTarget).not.toHaveBeenCalled();

      await passGate();
      expect(mockLoadPipelineTarget).toHaveBeenCalledWith(PROJECT_TARGET);
      expect(
        document.querySelector('[data-testid="mock-share-pipeline"]')
          ?.textContent,
      ).toBe('CI');
      expect(mockPipelineProps?.worktree).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      expect(mockTrack).toHaveBeenCalledWith('pipeline', 'artifact_card');

      act(() => mockPipelineProps?.onClose());
      expect(useShareRequestStore.getState().request).toBeNull();
    });

    it('says so and releases a pipeline that no longer resolves', async () => {
      mockLoadPipelineTarget.mockResolvedValue({ error: 'Pipeline not found' });
      render();
      act(() => {
        requestShare(PROJECT_TARGET, { source: 'artifact_card' });
      });
      await flush();
      await passGate();
      expect(
        document.querySelector('[data-testid="mock-share-pipeline"]'),
      ).toBeNull();
      expect(useShareRequestStore.getState().request).toBeNull();
      expect(mockAddToast).toHaveBeenCalledWith(
        SHARE_TARGET_UNRESOLVED_MESSAGE,
        'error',
        undefined,
        { forceInApp: true },
      );
    });
  });

  it('lets a newer request replace one still waiting at the gate', async () => {
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'artifact_card' });
    });
    await flush();
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'usage_nudge' });
    });
    await flush();
    expect(mockShare).toHaveBeenCalledTimes(2);

    // The first request's sign-in finishing late opens nothing.
    await passGate(0);
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="mock-share-plugin"]'),
    ).toBeNull();
    expect(mockTrack).not.toHaveBeenCalled();

    await passGate(1);
    expect(
      document.querySelector('[data-testid="mock-share-plugin"]'),
    ).not.toBeNull();
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('plugin', 'usage_nudge');
  });

  it('says so and releases a request that cannot resolve', async () => {
    mockData = data({ installedSkills: [] });
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'agent' });
    });
    await flush();
    await passGate();
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[0]).toBe(
      SHARE_TARGET_UNRESOLVED_MESSAGE,
    );
    expect(useShareRequestStore.getState().request).toBeNull();
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('waits for an inventory that is still loading instead of failing', async () => {
    mockData = data({
      installedSkills: null,
      localSettled: false,
      skillsSettled: false,
    });
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'agent' });
    });
    await flush();
    await passGate();
    expect(mockAddToast).not.toHaveBeenCalled();
    expect(useShareRequestStore.getState().request).not.toBeNull();

    act(() => {
      mockData = data({});
      root.render(<ChatShareHost />);
    });
    await flush();
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).not.toBeNull();
  });

  it('clears on close without reporting a share', async () => {
    const completed = jest.fn<void, [ShareRequest]>();
    const unsubscribe = subscribeShareCompleted(completed);
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    await passGate();
    act(() => mockSkillProps?.onClose());
    expect(useShareRequestStore.getState().request).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
    unsubscribe();
  });

  it('reports a completed share with its nudge origin and clears on Done', async () => {
    const completed = jest.fn<void, [ShareRequest]>();
    const unsubscribe = subscribeShareCompleted(completed);
    const origin = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      pendingId: 'pending-1',
    };
    render();
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'usage_nudge', origin });
    });
    await flush();
    await passGate();
    act(() => mockPluginProps?.onShared?.());
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]?.[0]).toMatchObject({
      target: PLUGIN_TARGET,
      source: 'usage_nudge',
      origin,
    });
    // The dialog stays open on its success notice until the author is done.
    // Share data refreshes only on close: a refresh now would unsettle the
    // inventory the dialog resolves from and remount it.
    expect(useShareRequestStore.getState().request).not.toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="mock-share-plugin"]'),
    ).not.toBeNull();
    await flush();
    expect(resolveNudge).toHaveBeenCalledWith({
      ...origin,
      target: PLUGIN_TARGET,
      resolution: 'shared',
    });
    act(() => mockPluginProps?.onClose());
    expect(useShareRequestStore.getState().request).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="mock-share-plugin"]'),
    ).toBeNull();
    unsubscribe();
  });

  it('ignores stale completion after a replacement is requested', async () => {
    const completed = jest.fn<void, [ShareRequest]>();
    const unsubscribe = subscribeShareCompleted(completed);
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    await passGate();
    const stale = mockSkillProps?.onShared;
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'activity_panel' });
    });
    await flush();
    act(() => stale?.());
    expect(completed).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(useShareRequestStore.getState().request?.target).toEqual(
      PLUGIN_TARGET,
    );
    unsubscribe();
  });

  it('ignores a gate continuation belonging to an unmounted host', async () => {
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'agent' });
    });
    await flush();
    const stale = mockShare.mock.calls[0]?.[1];
    const current = useShareRequestStore.getState().request;
    act(() => root.unmount());
    root = createRoot(container);
    render();
    // A replacement host can receive a request retained by another host.
    act(() => useShareRequestStore.setState({ request: current }));
    await flush();
    act(() => stale?.());
    await flush();
    expect(
      document.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
  });

  it('ignores a stale close after a replacement opened', async () => {
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    await passGate();
    const staleClose = mockSkillProps?.onClose;
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'activity_panel' });
    });
    await flush();
    await passGate();
    act(() => staleClose?.());
    expect(useShareRequestStore.getState().request?.target).toEqual(
      PLUGIN_TARGET,
    );
    expect(
      document.querySelector('[data-testid="mock-share-plugin"]'),
    ).not.toBeNull();
  });

  it('opens in the originating document and falls back when it is gone', async () => {
    const popout = document.implementation.createHTMLDocument('popout');
    let closed = false;
    const view = {
      get closed(): boolean {
        return closed;
      },
      addEventListener: jest.fn<void, [string, () => void]>(),
      removeEventListener: jest.fn(),
    };
    Object.defineProperty(popout, 'defaultView', { get: () => view });
    Object.defineProperty(popout.body, 'isConnected', { get: () => !closed });

    render();
    act(() => {
      requestShare(SKILL_TARGET, {
        source: 'mention_detail',
        ownerDocument: popout,
      });
    });
    await flush();
    await passGate();
    // The real dialog portals itself into the document it is handed.
    expect(mockSkillProps?.ownerDocument).toBe(popout);

    // The pop-out closes: the dialog moves to the main window.
    closed = true;
    const repick = view.addEventListener.mock.calls.find(
      ([type]) => type === 'pagehide',
    )?.[1];
    act(() => repick?.());
    await flush();
    expect(mockSkillProps?.ownerDocument).toBeUndefined();
    expect(
      document.body.querySelector('[data-testid="mock-share-skill"]'),
    ).not.toBeNull();
  });

  it('falls back if the originating window closes while the dialog is suspended', async () => {
    const popout = document.implementation.createHTMLDocument('popout');
    let closed = false;
    const view = {
      get closed(): boolean {
        return closed;
      },
      addEventListener: jest.fn<void, [string, () => void]>(),
      removeEventListener: jest.fn(),
    };
    Object.defineProperty(popout, 'defaultView', { get: () => view });
    let finishLoading = (): void => {};
    mockSkillLoad = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    render();
    act(() => {
      requestShare(SKILL_TARGET, {
        source: 'mention_detail',
        ownerDocument: popout,
      });
    });
    await flush();
    await passGate();
    expect(mockTrack).not.toHaveBeenCalled();
    closed = true;
    const repick = view.addEventListener.mock.calls.find(
      ([type]) => type === 'pagehide',
    )?.[1];
    act(() => repick?.());
    await act(async () => {
      const pendingLoad = mockSkillLoad;
      mockSkillLoad = null;
      finishLoading();
      await pendingLoad;
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="mock-share-skill"]'),
    ).not.toBeNull();
    expect(mockSkillProps?.ownerDocument).toBeUndefined();
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('does not open or record a suspended dialog replaced by another request', async () => {
    let finishLoading = (): void => {};
    mockSkillLoad = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    await passGate();
    expect(mockTrack).not.toHaveBeenCalled();
    act(() => {
      requestShare(PLUGIN_TARGET, { source: 'activity_panel' });
    });
    await flush();
    await passGate();
    await act(async () => {
      const pendingLoad = mockSkillLoad;
      mockSkillLoad = null;
      finishLoading();
      await pendingLoad;
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="mock-share-skill"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-testid="mock-share-plugin"]'),
    ).not.toBeNull();
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('plugin', 'activity_panel');
  });

  it('releases the request when the sign-in prompt is dismissed', async () => {
    jest.useFakeTimers();
    try {
      render();
      act(() => {
        requestShare(SKILL_TARGET, { source: 'artifact_card' });
      });
      await flush();
      act(() => {
        mockGateModal = <div data-testid="mock-gate" />;
        root.render(<ChatShareHost />);
      });
      await flush();
      expect(useShareRequestStore.getState().request).not.toBeNull();
      act(() => {
        mockGateModal = null;
        root.render(<ChatShareHost />);
      });
      await flush();
      act(() => {
        mockShare.mock.calls[0]?.[2]?.();
      });
      expect(useShareRequestStore.getState().request).toBeNull();
      expect(mockTrack).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for the gate decision after its modal closes', async () => {
    jest.useFakeTimers();
    try {
      render();
      act(() => {
        requestShare(SKILL_TARGET, { source: 'artifact_card' });
      });
      await flush();
      act(() => {
        mockGateModal = <div data-testid="mock-gate" />;
        root.render(<ChatShareHost />);
      });
      await flush();
      act(() => {
        mockGateModal = null;
        root.render(<ChatShareHost />);
      });
      await flush();
      act(() => jest.runOnlyPendingTimers());
      expect(useShareRequestStore.getState().request).not.toBeNull();
      await passGate();
      expect(
        document.querySelector('[data-testid="mock-share-skill"]'),
      ).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens account settings through the app action dispatcher', async () => {
    render();
    act(() => {
      requestShare(SKILL_TARGET, { source: 'mention_detail' });
    });
    await flush();
    await passGate();
    act(() => mockSkillProps?.onOpenAccountSettings());
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ui',
        action: { type: 'canopy_portal.open_account_settings' },
      }),
    );
    expect(useShareRequestStore.getState().request).toBeNull();
  });
});
