/**
 * @jest-environment jsdom
 *
 * CAN-5219: installing a shared skill over a chat keeps the user in that
 * chat. The review closes, nothing navigates, and the installation notice
 * offers Use in this chat for the chat the review opened over. An installed
 * skill's review offers the same action. Without a chat, or when the user
 * moved on during the install, the existing reveal is kept or skipped so a
 * finished install never pulls the user away.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import type {
  PublicShareInstallResult,
  PublicShareInstalledTarget,
  PublicShareLanding,
} from '../usePublicShareLanding';
import type {
  ShareChatInsertOutcome,
  ShareChatTarget,
} from '../shareChatTarget';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_ID = '4f4f51c1-a72b-4e12-9320-a038b90189f0';

const skillSnapshot: Extract<PublicShareSnapshot, { entity: 'skill' }> = {
  entity: 'skill',
  externalId: SKILL_ID,
  name: 'Incident Triage',
  description: 'Triages incidents.',
  rawSkill: '---\nname: incident-triage\n---\n# Incident triage',
  contentHash: 'c'.repeat(64),
  dependencies: [],
  authorUsername: 'morgan',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

let mockInstalled: PublicShareInstalledTarget | null = null;
const mockInstall = jest.fn<Promise<PublicShareInstallResult | null>, []>();
const mockInsertInChat = jest.fn<
  Promise<ShareChatInsertOutcome>,
  [PublicShareInstalledTarget, ShareChatTarget]
>();

jest.mock('../usePublicShareLanding', () => ({
  usePublicShareLanding: (): Partial<PublicShareLanding> => ({
    state: { phase: 'ready', snapshot: skillSnapshot },
    snapshot: skillSnapshot,
    detecting: false,
    verificationError: '',
    needsRefresh: false,
    refresh: jest.fn(),
    installed: mockInstalled,
    installing: false,
    installError: '',
    installProgress: '',
    installStatus: '',
    uninstalling: false,
    agentReadinessLoading: false,
    install: mockInstall,
    insertInChat: mockInsertInChat,
    manage: jest.fn(),
    uninstall: jest.fn(() => Promise.resolve(true)),
    tryNow: jest.fn(),
    installReview: null,
    openingInstallReview: false,
    closeInstallReview: jest.fn(),
    completeInstallReview: jest.fn(),
  }),
}));
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): { projectsInContext: [] } => ({
    projectsInContext: [],
  }),
}));

import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useGitHubStore, type ToastMeta } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { ShareInstallModalHost } from '../ShareInstallModal';

const LINK: DeepLinkShareOpenEvent = {
  entity: 'skill',
  externalId: SKILL_ID,
  intent: 'install',
};
const KEY = 'project/worktree';
const TARGET: ShareChatTarget = {
  projectId: 'project',
  worktreeId: 'worktree',
  tabId: 'chat-a',
};
// A collision rename: the invocation follows the installed folder.
const INSTALLED: PublicShareInstallResult = {
  target: {
    entity: 'skill',
    sourceId: 'custom:app',
    skillName: 'incident-triage-2',
  },
  status: '',
  partial: false,
};

let container: HTMLDivElement;
let root: Root;

function makeTab(id: string): ChatTab {
  return {
    id,
    title: 'Checkout latency spike',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
  };
}

function seedChat(activeTabId: string): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      [KEY]: { activeTabId, tabs: [makeTab('chat-a'), makeTab('chat-b')] },
    },
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function openLanding(): void {
  act(() => {
    root.render(<ShareInstallModalHost />);
  });
  act(() => {
    useNavigationStore.getState().openShareInstall(LINK, 'deep-link');
  });
}

async function clickInstall(): Promise<void> {
  await act(async () => {
    byTestId('deep-link-share-install')?.click();
    await Promise.resolve();
  });
}

interface Notice {
  message: string;
  type: 'error' | 'info' | 'success' | 'warning';
  meta?: ToastMeta;
}

/** Every notice raised, whether or not in-app notifications show it. */
let notices: Notice[] = [];
const realAddToast = useGitHubStore.getState().addToast;

function lastToast(): Notice {
  const notice = notices.at(-1);
  if (!notice) throw new Error('no notice');
  return notice;
}

beforeEach(() => {
  for (const id of ['chat-a', 'chat-b']) {
    const composer = document.createElement('div');
    composer.dataset.chatComposerTabId = id;
    composer.innerHTML =
      '<div data-chat-textarea contenteditable="true"></div>';
    composer.getClientRects = (): DOMRectList =>
      Object.assign([new DOMRect()], { item: (): DOMRect => new DOMRect() });
    document.body.appendChild(composer);
  }
  jest.clearAllMocks();
  mockInstalled = null;
  mockInsertInChat.mockResolvedValue('inserted');
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    canopyPortalOpen: false,
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
    pendingSkillViewer: undefined,
  });
  notices = [];
  useGitHubStore.setState({
    toasts: [],
    notifications: [],
    addToast: (message, type, onClick, meta, onDismiss): void => {
      notices.push({ message, type, ...(meta ? { meta } : {}) });
      realAddToast(message, type, onClick, meta, onDismiss);
    },
  });
  seedChat('chat-a');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('installing a shared skill over a chat', () => {
  it('closes the review, stays in the chat, and offers Use in this chat', async () => {
    mockInstall.mockResolvedValue(INSTALLED);
    openLanding();

    await clickInstall();

    const navigation = useNavigationStore.getState();
    expect(navigation.pendingShareInstall).toBeUndefined();
    expect(navigation.activePage).toBe('main');
    expect(navigation.pendingSkillViewer).toBeUndefined();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-a',
    );
    expect(notices).toHaveLength(1);
    const toast = lastToast();
    expect(toast.message).toBe('Skill installed.');
    expect(toast.meta?.action?.label).toBe('Use in this chat');

    await act(async () => {
      await toast.meta?.action?.onClick();
    });
    expect(mockInsertInChat).toHaveBeenCalledTimes(1);
    expect(mockInsertInChat).toHaveBeenCalledWith(INSTALLED.target, TARGET);
  });

  it('only reports the install when the user switched chats during it', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    openLanding();
    await clickInstall();

    act(() => {
      seedChat('chat-b');
    });
    await act(async () => {
      pending.resolve(INSTALLED);
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    const toast = lastToast();
    expect(toast.message).toBe('Skill installed.');
    expect(toast.meta?.action).toBeUndefined();
    expect(mockInsertInChat).not.toHaveBeenCalled();
  });

  it('does not revive an offer after switching away and returning during installation', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    openLanding();
    await clickInstall();
    act(() => seedChat('chat-b'));
    act(() => seedChat('chat-a'));
    await act(async () => {
      pending.resolve(INSTALLED);
      await pending.promise;
    });
    expect(lastToast().meta?.action).toBeUndefined();
    expect(useNavigationStore.getState().activePage).toBe('main');
  });

  it.each([false, true])(
    'never reveals an older result over a held link (partial=%s)',
    async (partial) => {
      useNavigationStore.setState({ activePage: 'home' });
      const pending = deferred<PublicShareInstallResult | null>();
      mockInstall.mockReturnValue(pending.promise);
      openLanding();
      await clickInstall();
      const newer = { ...LINK, externalId: 'newer-share' };
      act(() =>
        useNavigationStore.getState().openShareInstall(newer, 'deep-link'),
      );
      await act(async () => {
        pending.resolve({ ...INSTALLED, partial });
        await pending.promise;
      });
      expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(
        newer,
      );
      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
      expect(lastToast().meta?.action).toBeUndefined();
    },
  );

  it('does not reveal a partial install over newly selected work', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    openLanding();
    await clickInstall();
    act(() => useNavigationStore.setState({ activePage: 'overview' }));
    await act(async () => {
      pending.resolve({ ...INSTALLED, partial: true });
      await pending.promise;
    });
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(lastToast().type).toBe('warning');
  });

  it('does not create an offer after its originating component is dismissed', async () => {
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    openLanding();
    await clickInstall();
    act(() => root.render(null));
    await act(async () => {
      pending.resolve(INSTALLED);
      await pending.promise;
    });
    expect(lastToast().meta?.action).toBeUndefined();
    expect(useNavigationStore.getState().activePage).toBe('main');
  });

  it('keeps the reveal for a partial install, where its warning lives', async () => {
    mockInstall.mockResolvedValue({
      ...INSTALLED,
      status: 'Skill installed. 1 supporting file is unavailable.',
      partial: true,
    });
    openLanding();

    await clickInstall();

    expect(useNavigationStore.getState().activePage).toBe('plugins');
    const toast = lastToast();
    expect(toast.type).toBe('warning');
    expect(toast.meta?.action).toBeUndefined();
  });

  it('offers nothing after a failed install', async () => {
    mockInstall.mockResolvedValue(null);
    openLanding();

    await clickInstall();

    expect(byTestId('deep-link-share-landing')).not.toBeNull();
    expect(notices).toEqual([]);
  });
});

describe('installing a shared skill outside a chat', () => {
  it('does not reveal it if the user moved on during the install', async () => {
    useNavigationStore.setState({ activePage: 'home' });
    const pending = deferred<PublicShareInstallResult | null>();
    mockInstall.mockReturnValue(pending.promise);
    openLanding();
    await clickInstall();

    act(() => {
      useNavigationStore.setState({ activePage: 'overview' });
    });
    await act(async () => {
      pending.resolve(INSTALLED);
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(lastToast().meta?.action).toBeUndefined();
  });
});

it('does not reveal after leaving and returning to the original non-chat page', async () => {
  useNavigationStore.setState({ activePage: 'home' });
  const pending = deferred<PublicShareInstallResult | null>();
  mockInstall.mockReturnValue(pending.promise);
  openLanding();
  await clickInstall();
  act(() => useNavigationStore.setState({ activePage: 'overview' }));
  act(() => useNavigationStore.setState({ activePage: 'home' }));
  await act(async () => {
    pending.resolve(INSTALLED);
    await pending.promise;
  });
  expect(useNavigationStore.getState().activePage).toBe('home');
  expect(lastToast().meta?.action).toBeUndefined();
});

describe('an installed skill’s review over a chat', () => {
  beforeEach(() => {
    mockInstalled = INSTALLED.target;
  });

  it('uses the skill in the chat and closes', async () => {
    openLanding();

    const primary = byTestId('deep-link-share-use-in-chat');
    expect(primary?.textContent).toBe('Use in this chat');
    await act(async () => {
      primary?.click();
      await Promise.resolve();
    });

    expect(mockInsertInChat).toHaveBeenCalledWith(INSTALLED.target, TARGET);
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
    expect(useNavigationStore.getState().pendingSkillViewer).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it('stays open and says why when the chat could not take it', async () => {
    mockInsertInChat.mockResolvedValue('unhandled');
    openLanding();

    await act(async () => {
      byTestId('deep-link-share-use-in-chat')?.click();
      await Promise.resolve();
    });

    expect(byTestId('deep-link-share-landing')).not.toBeNull();
    expect(lastToast().type).toBe('warning');
  });

  it('falls back to Open skill once the user leaves that chat', () => {
    openLanding();
    expect(byTestId('deep-link-share-use-in-chat')).not.toBeNull();

    act(() => {
      seedChat('chat-b');
    });

    expect(byTestId('deep-link-share-use-in-chat')).toBeNull();
    expect(byTestId('deep-link-share-open')?.textContent).toBe('Open skill');
  });
});
