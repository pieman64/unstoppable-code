/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToastContainer } from '@/components/shared/ToastContainer';
import {
  PERSISTENT_TOAST_LIFETIME_MS,
  TOAST_LIFETIME_MS,
  useGitHubStore,
  type Toast,
} from '@/stores/githubStore';
import {
  useLabsExperimentsStore,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import { makeTestLabsSnapshot } from '@/test-utils/labsExperiments';

// Opens a destination in its workspace's context; in-context by default.
const openInWorkspaceContextMock = jest.fn(
  (_workspaceId: string, open: () => void): void => {
    open();
  },
);
jest.mock('@/lib/contextScope', () => ({
  openInWorkspaceContext: (workspaceId: string, open: () => void): void =>
    openInWorkspaceContextMock(workspaceId, open),
}));

const dismissPageLikeViewersMock = jest.fn();
jest.mock('@/lib/dismissPageLikeViewers', () => ({
  dismissPageLikeViewers: (): void => {
    dismissPageLikeViewersMock();
  },
}));

function setStackEnabled(enabled: boolean): void {
  useLabsExperimentsStore.setState({
    snapshot: makeTestLabsSnapshot({
      earlyAccess: !enabled,
      experiments: [
        {
          id: 'stacked-notifications',
          requiresEarlyAccess: false,
          choice: enabled,
        },
      ],
    }),
  });
}

import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { postShareToast } from '@/lib/share-toast';
import { refreshInAppNotificationPrefs } from '@/lib/osNotifications';
import {
  noticeButtonClassName,
  SUCCESS_TOAST_LIFETIME_MS,
} from '@canopy/ui-shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let writeTextMock: jest.Mock<Promise<void>, [string]>;
let openLinkMock: jest.Mock;
let openAuthenticatedPortalPageMock: jest.Mock;
let showOsNotificationMock: jest.Mock;

const SHARE_URL = 'https://cloud.example.test/plans/plan-123';

function installClipboard(): void {
  writeTextMock = jest
    .fn<Promise<void>, [string]>()
    .mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  });
}

function installApi(): void {
  openLinkMock = jest.fn().mockResolvedValue(undefined);
  openAuthenticatedPortalPageMock = jest.fn().mockResolvedValue(true);
  showOsNotificationMock = jest.fn().mockResolvedValue({ shown: true });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: { openLink: openLinkMock },
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test/'),
      openAuthenticatedPortalPage: openAuthenticatedPortalPageMock,
      showOsNotification: showOsNotificationMock,
    },
  });
}

function setInAppEnabled(enabled: boolean): void {
  refreshInAppNotificationPrefs({
    enabled,
    placement: 'bottom-right',
    categories: {
      chat: enabled,
      script: enabled,
      hook: enabled,
      gitCommit: enabled,
      gitPush: enabled,
      prCreate: enabled,
      pipeline: enabled,
      terminal: enabled,
      runComment: enabled,
      activation: enabled,
    },
  });
}

function seedToast(meta: Toast['meta']): void {
  const toast: Toast = {
    id: 'toast-1',
    message: 'Plan shared.',
    type: 'success',
    createdAt: 0,
    meta,
  };
  useGitHubStore.setState({ toasts: [toast] });
}

function makeToast(id: string, message: string, meta?: Toast['meta']): Toast {
  return {
    id,
    message,
    type: 'success',
    createdAt: Number(id.replace(/\D/g, '')) || 0,
    meta,
  };
}

function render(
  placement?: Parameters<typeof ToastContainer>[0]['placement'],
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ToastContainer placement={placement} />);
  });
}

function expandNotification(): void {
  act(() => {
    useGitHubStore.setState((state) => ({
      toasts: state.toasts.map((toast) => ({
        ...toast,
        message: `${toast.message}\n${'x'.repeat(400)}`,
      })),
    }));
  });
  act(() => {
    container
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label="Read full notification"]',
      )
      ?.click();
  });
}

beforeEach(() => {
  installClipboard();
  installApi();
  setInAppEnabled(true);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  resetLabsExperimentsStoreForTest();
  root = null;
  container?.remove();
  container = null;
  useGitHubStore.setState({ toasts: [], notifications: [] });
  setStackEnabled(false);
  setInAppEnabled(true);
});

describe('ToastContainer link actions', () => {
  it('always shows a share toast in-app, keeps its link, and suppresses OS notification', () => {
    jest.useFakeTimers();
    try {
      setInAppEnabled(false);

      act(() => {
        postShareToast({
          tone: 'success',
          message: 'Plan shared with Platform',
          link: SHARE_URL,
        });
      });

      const [toast] = useGitHubStore.getState().toasts;
      expect(toast).toMatchObject({
        message: 'Plan shared with Platform',
        type: 'success',
        meta: {
          forceInApp: true,
          suppressOsNotification: true,
          persistent: true,
          link: { url: SHARE_URL },
        },
      });
      expect(showOsNotificationMock).not.toHaveBeenCalled();

      render();
      expect(
        container?.querySelector('[data-testid="toast-copy-link"]'),
      ).not.toBeNull();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('does not render link actions when the toast has no link', () => {
    seedToast({ category: 'Pipeline' });
    render();
    expect(
      container?.querySelector('[data-testid="toast-card"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="toast-copy-link"]'),
    ).toBeNull();
  });

  it('copies the share link to the clipboard', async () => {
    seedToast({ link: { url: SHARE_URL } });
    render();

    const copyButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="toast-copy-link"]',
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton?.textContent).toBe('Copy link');

    await act(async () => {
      copyButton?.click();
      // Flush the clipboard promise so the "Copied" state update commits.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledWith(SHARE_URL);
    expect(copyButton?.textContent).toBe('Copied');
  });

  it('opens the share link through the app-link router', async () => {
    seedToast({ link: { url: SHARE_URL } });
    render();

    const openButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="toast-open-link"]',
    );
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });

    expect(openLinkMock).toHaveBeenCalledWith({ url: SHARE_URL });
    expect(openAuthenticatedPortalPageMock).not.toHaveBeenCalled();
  });

  // A share the account just made is a page of that account: opening it in
  // a browser signed out, or signed in to another account, shows sign-in or
  // "no access" instead of the share.
  it.each([
    [SHARE_URL, { auth: '/plans/plan-123' }],
    ['https://cloud.example.test/runs/r?x=1', { auth: '/runs/r?x=1' }],
    ['https://cloud.example.test.evil.example/plans/p', { router: true }],
    ['https://elsewhere.example/plans/p', { router: true }],
  ] as const)(
    'opens a share it made signed in to the account: %s',
    async (url, expected) => {
      seedToast({ link: { url, signedIn: true } });
      render();

      await act(async () => {
        container
          ?.querySelector<HTMLButtonElement>('[data-testid="toast-open-link"]')
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      if ('auth' in expected) {
        expect(openAuthenticatedPortalPageMock).toHaveBeenCalledWith(
          expected.auth,
        );
        expect(openLinkMock).not.toHaveBeenCalled();
      } else {
        expect(openAuthenticatedPortalPageMock).not.toHaveBeenCalled();
        expect(openLinkMock).toHaveBeenCalledWith({ url });
      }
    },
  );

  it('renders a labeled recovery action and dismisses after running it', async () => {
    const onClick = jest.fn();
    seedToast({ action: { label: 'Allow all sites', onClick } });
    render();

    const actionButton = container?.querySelector<HTMLButtonElement>(
      '[data-testid="toast-action"]',
    );
    expect(actionButton).not.toBeNull();
    expect(actionButton?.textContent).toBe('Allow all sites');

    await act(async () => {
      actionButton?.click();
      await Promise.resolve();
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useGitHubStore.getState().toasts).toHaveLength(0);
  });

  it('dismisses the backing toast after running its expanded recovery action', async () => {
    const onClick = jest.fn();
    seedToast({ action: { label: 'Allow all sites', onClick } });
    render();

    expandNotification();
    const modal = document.querySelector(
      '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
    );
    const actionButton = modal?.querySelector<HTMLButtonElement>(
      '[data-testid="toast-action"]',
    );
    expect(actionButton).not.toBeNull();

    await act(async () => {
      actionButton?.click();
      await Promise.resolve();
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useGitHubStore.getState().toasts).toHaveLength(0);
    expect(
      document.querySelector(
        '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
      ),
    ).toBeNull();
  });

  it('a slow action finishing late leaves another toast’s open dialog alone', async () => {
    let finish: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const long = 'x'.repeat(400);
    useGitHubStore.setState({
      toasts: [
        makeToast('toast-1', `First failure\n${long}`, {
          action: { label: 'Try again', onClick: () => slow },
        }),
        makeToast('toast-2', `Second failure\n${long}`),
      ],
    });
    render();
    const dialog = (): Element | null =>
      document.querySelector(
        '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
      );
    const readFull = (text: string): HTMLButtonElement | undefined =>
      Array.from(
        container?.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Read full notification"]',
        ) ?? [],
      ).find((button) =>
        button
          .closest('[data-testid="toast-card"]')
          ?.textContent?.includes(text),
      );

    act(() => readFull('First failure')?.click());
    await act(async () => {
      dialog()
        ?.querySelector<HTMLButtonElement>('[data-testid="toast-action"]')
        ?.click();
      await Promise.resolve();
    });
    // The first dialog closes while its action runs; the second one opens.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    act(() => readFull('Second failure')?.click());
    expect(dialog()?.textContent).toContain('Second failure');

    await act(async () => {
      finish();
      await slow;
    });
    expect(dialog()?.textContent).toContain('Second failure');
    expect(useGitHubStore.getState().toasts.map((toast) => toast.id)).toEqual([
      'toast-2',
    ]);
  });

  it('renders no action affordance when the toast carries none', () => {
    seedToast({ link: { url: SHARE_URL } });
    render();
    expect(container?.querySelector('[data-testid="toast-action"]')).toBeNull();
  });

  // CAN-3510: Copy link and Open are peer actions, so both render as the
  // standard toast action button (the one "Allow all sites" uses), with an
  // icon on each, in the compact toast and in the expanded view alike.
  it.each(['compact', 'expanded'] as const)(
    'renders Copy link and Open as matched toast action buttons (%s)',
    (view) => {
      seedToast({ link: { url: SHARE_URL } });
      render();
      let scope: ParentNode | null | undefined = container;
      if (view === 'expanded') {
        expandNotification();
        scope = document.querySelector(
          '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
        );
      }

      const copyButton = scope?.querySelector<HTMLButtonElement>(
        '[data-testid="toast-copy-link"]',
      );
      const openButton = scope?.querySelector<HTMLButtonElement>(
        '[data-testid="toast-open-link"]',
      );
      expect(copyButton).not.toBeNull();
      expect(openButton).not.toBeNull();

      const actionClasses = noticeButtonClassName(
        'secondary',
        '',
        view === 'compact' ? 'md' : 'sm',
      )
        .split(/\s+/)
        .filter(Boolean);
      const copyClasses = Array.from(copyButton?.classList ?? []);
      const openClasses = Array.from(openButton?.classList ?? []);
      expect(copyClasses.sort()).toEqual(openClasses.sort());
      expect(copyClasses).toEqual(expect.arrayContaining(actionClasses));

      expect(copyButton?.querySelector('svg')).not.toBeNull();
      expect(openButton?.querySelector('svg')).not.toBeNull();
      expect(copyButton?.textContent).toBe('Copy link');
      expect(openButton?.textContent).toBe('Open');
    },
  );

  it('uses the one Copy link treatment for every share toast', () => {
    seedToast({ link: { url: SHARE_URL } });
    render();
    expect(
      container?.querySelector('[data-testid="toast-copy-link"]')?.textContent,
    ).toBe('Copy link');
  });
});

describe('ToastContainer meta title', () => {
  it('mounts its polite status region before the first toast arrives', () => {
    render();

    const status = container?.querySelector(
      '[data-testid="toast-live-region"]',
    );
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('');
  });

  it('announces transactional toast outcomes through a polite status region', () => {
    seedToast({ category: 'Account', title: 'Sign in successful' });
    render();

    const status = container?.querySelector(
      '[data-testid="toast-live-region"]',
    );
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Sign in successful');
    expect(status?.textContent).toContain('Plan shared.');
  });

  it('renders a meta title as the bold lead in place of the category', () => {
    seedToast({ category: 'Account', title: 'Sign in successful' });
    render();

    const lead = container?.querySelector('[data-testid="toast-meta-title"]');
    expect(lead?.textContent).toBe('Sign in successful');
    // A title is a headline, not a routing chip: it must not render in the
    // quiet `text-2xs opacity-70` style, which would make it read as less
    // important than the message body under it.
    expect(lead?.parentElement?.parentElement?.className).toContain(
      'font-medium',
    );
    expect(lead?.parentElement?.parentElement?.className).not.toContain(
      'opacity-70',
    );
  });

  it('falls back to the category when no title is set', () => {
    seedToast({ category: 'Pipeline' });
    render();

    // The `Pipeline` category renders as the workflow item noun (CAN-4651).
    expect(
      container?.querySelector('[data-testid="toast-meta-title"]')?.textContent,
    ).toBe('Workflow');
    const header = container?.querySelector('[data-testid="toast-meta-title"]')
      ?.parentElement?.parentElement;
    expect(header?.className).toContain('font-medium');
  });

  it('labels title and category separately in the detail modal', () => {
    seedToast({ category: 'Account', title: 'Sign in successful' });
    render();

    expandNotification();

    expect(
      document.querySelector('[data-testid="toast-detail-title"]')?.textContent,
    ).toBe('Sign in successful');
    expect(
      document.querySelector('[data-testid="toast-detail-category"]')
        ?.textContent,
    ).toBe('Account');
  });

  it('names the Pipeline category Workflow in the detail modal', () => {
    seedToast({ category: 'Pipeline', title: 'Workflow failed' });
    render();

    expandNotification();

    expect(
      document.querySelector('[data-testid="toast-detail-category"]')
        ?.textContent,
    ).toBe('Workflow');
  });

  it('blocks a chat detail message from session replay but records the dialog', () => {
    seedToast({ category: 'Chat' });
    render();

    expandNotification();

    const modal = document.querySelector(
      '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
    );
    const body = modal?.querySelector('div.whitespace-pre-wrap');
    expect(body?.closest('.ph-no-capture')).not.toBeNull();
    expect(modal?.closest('.ph-no-capture')).toBeNull();
  });

  it('blocks a chat card message, which quotes the agent reply', () => {
    seedToast({ category: 'Chat' });
    render();

    const message = Array.from(container?.querySelectorAll('span') ?? [])
      .filter((node) => node.textContent?.startsWith('Plan shared.'))
      .at(-1);
    expect(message?.closest('.ph-no-capture')).not.toBeNull();
  });

  it('records a successful account message in the card and the dialog', () => {
    seedToast({ category: 'Account' });
    render();

    const card = Array.from(container?.querySelectorAll('span') ?? [])
      .filter((node) => node.textContent?.startsWith('Plan shared.'))
      .at(-1);
    expect(card?.closest('.ph-no-capture')).toBeNull();
    expandNotification();
    const body = Array.from(
      document
        .querySelector(
          '[role="dialog"][aria-labelledby="toast-detail-modal-title"]',
        )
        ?.querySelectorAll('div') ?? [],
    )
      .filter((node) => node.textContent?.startsWith('Plan shared.'))
      .at(-1);
    expect(body).toBeDefined();
    expect(body?.closest('.ph-no-capture')).toBeNull();
  });
});

describe('ToastContainer visibility priority', () => {
  it('keeps the newest operational notification at the front of the stack', () => {
    useGitHubStore.setState({
      toasts: [
        makeToast('toast-1', 'Persistent sign-in', {
          persistent: true,
          title: 'Sign in successful',
        }),
        makeToast('toast-2', 'New one'),
        makeToast('toast-3', 'New two'),
        makeToast('toast-4', 'Newest error'),
      ],
    });
    render();

    const visible = Array.from(
      container?.querySelectorAll('[data-testid="toast-card"]') ?? [],
    ).map((card) => card.textContent);
    expect(visible).toHaveLength(4);
    expect(visible.join(' ')).toContain('Newest error');
    expect(visible[0]).toContain('Newest error');
  });
});

describe('ToastContainer with stacked notifications on (shared ToastStack)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setStackEnabled(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function cards(): HTMLElement[] {
    return Array.from(
      container?.querySelectorAll<HTMLElement>('[data-testid="toast-card"]') ??
        [],
    );
  }

  function onlyCard(): HTMLElement {
    const [card, ...rest] = cards();
    if (card === undefined || rest.length > 0) {
      throw new Error(`expected one toast, found ${String(cards().length)}`);
    }
    return card;
  }

  function addToast(
    message: string,
    type: Toast['type'] = 'success',
    meta?: Toast['meta'],
    onClick?: () => void,
  ): void {
    act(() => {
      useGitHubStore.getState().addToast(message, type, onClick, meta);
    });
  }

  it('blocks an opted-in message, such as an invite naming a person, from session replay', () => {
    render();
    act(() => {
      postShareToast({
        message: 'Invited Ada Lovelace',
        tone: 'success',
        blockMessageFromReplay: true,
      });
    });

    const card = onlyCard();
    // The innermost span holds the text; ToastStackDescription wraps it.
    const message = Array.from(card.querySelectorAll('span'))
      .filter((node) => node.textContent === 'Invited Ada Lovelace')
      .at(-1);
    expect(message?.closest('.ph-no-capture')).not.toBeNull();
    // The card and its Dismiss button stay recorded.
    expect(card.closest('.ph-no-capture')).toBeNull();
    expect(
      card
        .querySelector('[data-testid="toast-dismiss"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();
  });

  it('records a message that does not opt in', () => {
    render();
    addToast('Plan shared.');

    const message = Array.from(onlyCard().querySelectorAll('span'))
      .filter((node) => node.textContent === 'Plan shared.')
      .at(-1);
    expect(message).toBeDefined();
    expect(message?.closest('.ph-no-capture')).toBeNull();
  });

  it('renders the shared stack in the configured corner', () => {
    render('top-left');

    const region = container?.querySelector(
      '[data-testid="toast-live-region"]',
    );
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('data-edge')).toBe('top');
  });

  it('draws each toast with the shared notice on the stack card', () => {
    render();
    addToast('Build failed', 'error', {
      category: 'Pipeline',
      title: 'Workflow failed',
    });

    const card = onlyCard();
    const notice = card.querySelector('[data-notice-intent]');
    expect(card.dataset.toastType).toBe('error');
    expect(notice?.getAttribute('data-notice-intent')).toBe('destructive');
    expect(notice?.getAttribute('data-notice-surface')).toBe('none');
    expect(
      card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
    ).toBe('Workflow failed');
    // The category is a routing key the title replaces; it is not repeated
    // on the card.
    expect(card.querySelector('[data-testid="toast-context"]')).toBeNull();
    expect(card.textContent).not.toContain('Workflow.');
    expect(card.textContent?.match(/Workflow/g)).toHaveLength(1);
    expect(card.textContent).toContain('Build failed');
  });

  it('leads with the project name when the toast has one', () => {
    render();
    addToast('demo-main · Fix redirect: I updated the auth flow.', 'info', {
      category: 'Chat',
      workspaceName: 'TypeScript pnpm Vite',
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
    });

    const card = onlyCard();
    expect(
      card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
    ).toBe('TypeScript pnpm Vite');
    expect(card.textContent).not.toContain('Chat');
    expect(card.textContent).toContain('I updated the auth flow.');
  });

  it('keeps the result title when a saved project has no known name', () => {
    render();
    addToast('2 rules apply to new chats.', 'success', {
      title: 'Cursor rules on',
      projectId: 'removed-project',
      forceInApp: true,
      suppressOsNotification: true,
    });

    const card = onlyCard();
    expect(
      card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
    ).toBe('Cursor rules on');
    expect(card.textContent).toContain('2 rules apply to new chats.');
  });

  function seedKnownProject(): void {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'code-1',
          name: 'canopy',
          repoPath: '/repo',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'mosquito',
              branchName: 'feature/toasts',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        },
      ],
      hasHydratedProjects: true,
    });
  }

  it('wears the project icon and names the project and worktree for an update from a known project', () => {
    const projectsBefore = useProjectsStore.getState();
    seedKnownProject();
    try {
      render();
      addToast('feature/toasts · Fix redirect: I updated the flow.', 'info', {
        category: 'Chat',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });

      const card = onlyCard();
      expect(
        card.querySelector('[data-testid="toast-project-icon"]'),
      ).not.toBeNull();
      expect(
        card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
      ).toBe('canopy · mosquito');
      expect(
        card.querySelector('[data-testid="toast-meta-worktree"]')?.className,
      ).toContain('fg-tertiary');
      expect(
        card.querySelector('[data-testid="toast-meta-worktree"]')?.textContent,
      ).toBe(' · mosquito');

      // A producer that sends no workspaceName still leads with the project.
      addToast('Chat finished', 'info', {
        category: 'Chat',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });
      const unnamed = cards().find((entry) =>
        entry.textContent?.includes('Chat finished'),
      );
      expect(
        unnamed?.querySelector('[data-testid="toast-meta-title"]')?.textContent,
      ).toBe('canopy · mosquito');
      const message = card.querySelector('[data-notice-title-layout="stacked"]')
        ?.children[1];
      expect(message?.className).toContain('fg-secondary');

      // A failure keeps its own glyph and still names project and worktree.
      addToast('Push rejected', 'error', {
        category: 'Git Push',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });
      const failure = cards().find(
        (entry) => entry.dataset.toastType === 'error',
      );
      expect(
        failure?.querySelector('[data-testid="toast-project-icon"]'),
      ).toBeNull();
      expect(
        failure?.querySelector('[data-testid="toast-meta-title"]')?.textContent,
      ).toBe('canopy · mosquito');
    } finally {
      useProjectsStore.setState(projectsBefore);
    }
  });

  it('opens the worktree from a worktree toast that has no click handler', () => {
    const projectsBefore = useProjectsStore.getState();
    const chatBefore = useChatStore.getState();
    const navigationBefore = useNavigationStore.getState();
    const selectWorktree = jest.fn();
    const navigate = jest.fn();
    seedKnownProject();
    useChatStore.setState({ selectWorktree });
    useNavigationStore.setState({ navigate });
    try {
      render();
      // A failed setup script toasts with its worktree but no onClick.
      addToast('Setup failed — exit 1', 'error', {
        category: 'Script',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });

      const card = onlyCard();
      expect(
        card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
      ).toBe('canopy · mosquito');
      expect(
        card.querySelector('button[aria-label="Open notification"]'),
      ).not.toBeNull();
      act(() => card.click());

      // An open archive or shared-container viewer closes first.
      expect(dismissPageLikeViewersMock).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('main');
      expect(selectWorktree).toHaveBeenCalledWith('code-1', 'mosquito');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    } finally {
      useProjectsStore.setState(projectsBefore);
      useChatStore.setState(chatBefore);
      useNavigationStore.setState(navigationBefore);
    }
  });

  it('names a Cowork entry after the project, from its sidebar row first', () => {
    const projectsBefore = useProjectsStore.getState();
    const standaloneBefore = useStandaloneChatStore.getState();
    const chatBefore = useChatStore.getState();
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'My Cowork',
          color: '#000000',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });
    useChatStore.setState({
      worktreeChats: {
        'cowork-1/entry-1': {
          ...chatBefore.worktreeChats['cowork-1/entry-1'],
          tabs: [
            {
              id: 'chat-1',
              title: 'New Chat',
              description: 'Draft the quarterly planning report',
              createdAt: '2026-10-01T00:00:00.000Z',
              messages: [],
            },
          ],
        },
      } as unknown as ReturnType<typeof useChatStore.getState>['worktreeChats'],
    });
    const coworkMeta = {
      category: 'Chat' as const,
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    };
    try {
      render();
      // Before the sidebar rows load, the chat's generated description names it.
      addToast('Report drafted.', 'info', coworkMeta);
      const title = (): Element | null =>
        onlyCard().querySelector('[data-testid="toast-meta-title"]');
      expect(title()?.textContent).toBe(
        'My Cowork · Draft the quarterly planning report',
      );
      const entry = onlyCard().querySelector(
        '[data-testid="toast-meta-worktree"]',
      );
      expect(entry?.className).toContain('truncate');
      expect(entry?.className).toContain('fg-tertiary');

      // The sidebar row's rename wins once the rows are loaded.
      act(() => {
        useStandaloneChatStore.setState({
          sidebarEntriesByProject: {
            'cowork-1': [
              {
                id: 'entry-1',
                title: 'Q3 report',
                createdAt: '2026-10-01T00:00:00.000Z',
                chatCount: 1,
              },
            ],
          },
        });
      });
      expect(title()?.textContent).toBe('My Cowork · Q3 report');
    } finally {
      useProjectsStore.setState(projectsBefore);
      useStandaloneChatStore.setState(standaloneBefore);
      useChatStore.setState(chatBefore);
    }
  });

  it('opens a cut-off worktree toast in full instead of leaving for the worktree', () => {
    const projectsBefore = useProjectsStore.getState();
    const chatBefore = useChatStore.getState();
    const selectWorktree = jest.fn();
    seedKnownProject();
    useChatStore.setState({ selectWorktree });
    try {
      render();
      const detail = 'y'.repeat(400);
      addToast(`Push failed\n${detail}`, 'error', {
        category: 'Git Push',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });

      const card = onlyCard();
      expect(
        card.querySelector('button[aria-label="Read full notification"]'),
      ).not.toBeNull();
      act(() => card.click());

      expect(selectWorktree).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(detail);
      expect(useGitHubStore.getState().toasts).toHaveLength(1);
    } finally {
      useProjectsStore.setState(projectsBefore);
      useChatStore.setState(chatBefore);
    }
  });

  it('opens a worktree toast only once its workspace context has switched', () => {
    const projectsBefore = useProjectsStore.getState();
    const chatBefore = useChatStore.getState();
    const navigationBefore = useNavigationStore.getState();
    const selectWorktree = jest.fn();
    seedKnownProject();
    useChatStore.setState({ selectWorktree });
    useNavigationStore.setState({ navigate: jest.fn() });
    let finishSwitch: (() => void) | undefined;
    openInWorkspaceContextMock.mockImplementationOnce(
      (_workspaceId, open): void => {
        finishSwitch = open;
      },
    );
    try {
      render();
      addToast('Setup failed — exit 1', 'error', {
        category: 'Script',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'mosquito',
      });
      act(() => onlyCard().click());

      // Switching context: nothing opens and the toast stays up.
      expect(openInWorkspaceContextMock).toHaveBeenLastCalledWith(
        'code-1',
        expect.any(Function),
      );
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(useGitHubStore.getState().toasts).toHaveLength(1);

      act(() => finishSwitch?.());
      expect(selectWorktree).toHaveBeenCalledWith('code-1', 'mosquito');
      expect(useGitHubStore.getState().toasts).toEqual([]);
    } finally {
      useProjectsStore.setState(projectsBefore);
      useChatStore.setState(chatBefore);
      useNavigationStore.setState(navigationBefore);
    }
  });

  it('leaves a toast for a worktree that no longer exists unclickable', () => {
    const projectsBefore = useProjectsStore.getState();
    seedKnownProject();
    try {
      render();
      addToast('Setup failed — exit 1', 'error', {
        category: 'Script',
        workspaceName: 'canopy',
        projectId: 'code-1',
        worktreeId: 'archived-owl',
      });

      const card = onlyCard();
      expect(
        card.querySelector('button[aria-label="Open notification"]'),
      ).toBeNull();
      expect(
        card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
      ).toBe('canopy');
    } finally {
      useProjectsStore.setState(projectsBefore);
    }
  });

  it('keeps a title the project displaces at the start of the message', () => {
    render();
    addToast('Pull, then push again.', 'error', {
      category: 'Git Push',
      title: 'Push failed',
      workspaceName: 'TypeScript pnpm Vite',
    });

    const card = onlyCard();
    expect(
      card.querySelector('[data-testid="toast-meta-title"]')?.textContent,
    ).toBe('TypeScript pnpm Vite');
    expect(card.textContent).toContain('Push failed. Pull, then push again.');
  });

  it('hides an expired toast but keeps it in notification history', () => {
    render();
    addToast('Push complete', 'info');

    act(() => jest.advanceTimersByTime(TOAST_LIFETIME_MS - 1));
    expect(cards()).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));

    expect(useGitHubStore.getState().toasts).toEqual([]);
    expect(
      useGitHubStore.getState().notifications.map((entry) => entry.message),
    ).toEqual(['Push complete']);
    act(() => jest.advanceTimersByTime(1_000));
    expect(cards()).toHaveLength(0);
  });

  it('lets a success leave after 6 seconds', () => {
    render();
    addToast('Share link copied.', 'success');

    act(() => jest.advanceTimersByTime(SUCCESS_TOAST_LIFETIME_MS - 1));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('keeps a failure until it is closed', () => {
    render();
    addToast('The canopy project did not answer in time.', 'error', {
      title: "Couldn't start Release notes",
    });

    act(() => jest.advanceTimersByTime(PERSISTENT_TOAST_LIFETIME_MS * 5));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
    act(() => {
      onlyCard()
        .querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')
        ?.click();
    });
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('spins Try again inside the toast until the retry settles, then closes it', async () => {
    render();
    let finish: () => void = () => undefined;
    const retry = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    addToast('The canopy project did not answer in time.', 'error', {
      title: "Couldn't start Release notes",
      action: {
        label: 'Try again',
        busyLabel: 'Trying again…',
        onClick: retry,
      },
    });

    const button = (): HTMLButtonElement | null =>
      onlyCard().querySelector<HTMLButtonElement>(
        '[data-testid="toast-action"]',
      );
    act(() => button()?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(button()?.textContent).toBe('Trying again…');
    expect(button()?.getAttribute('aria-busy')).toBe('true');
    expect(useGitHubStore.getState().toasts).toHaveLength(1);

    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('keeps a persistent toast up for a minute', () => {
    render();
    addToast('Plan shared.', 'success', { persistent: true });

    act(() => jest.advanceTimersByTime(PERSISTENT_TOAST_LIFETIME_MS - 1));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('holds the clock while the pointer is over the stack', () => {
    render();
    addToast('Push complete');

    act(() => {
      onlyCard().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(TOAST_LIFETIME_MS * 3));

    expect(useGitHubStore.getState().toasts).toHaveLength(1);
  });

  it('removes the toast and its history entry from Dismiss', () => {
    render();
    addToast('Push complete');

    act(() => {
      onlyCard()
        .querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')
        ?.click();
    });

    expect(useGitHubStore.getState().toasts).toEqual([]);
    expect(useGitHubStore.getState().notifications).toEqual([]);
  });

  it('opens a long message in full from the card, with no Details button', () => {
    render();
    const long = `First line\n${'x'.repeat(400)}`;
    addToast(long, 'error');

    const card = onlyCard();
    expect(card.textContent).toContain('…');
    expect(card.textContent).not.toContain('x'.repeat(400));
    expect(card.querySelector('[data-testid="toast-details"]')).toBeNull();
    expect(card.querySelector('[data-notice-actions]')).toBeNull();
    // The card's pointer target must not be a button: a swipe never starts
    // inside an interactive element.
    expect(card.getAttribute('role')).toBeNull();
    expect(
      card.querySelector('button[aria-label="Read full notification"]'),
    ).not.toBeNull();
    act(() => card.click());

    expect(document.body.textContent).toContain('x'.repeat(400));
    // Reading the message leaves the toast up.
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
  });

  it('closes only the full-message dialog on Escape, keeping the toast', () => {
    render();
    addToast(`First line\n${'x'.repeat(400)}`, 'error');

    const card = onlyCard();
    const keyboardAction = card.querySelector<HTMLButtonElement>(
      'button[aria-label="Read full notification"]',
    );
    expect(keyboardAction).not.toBeNull();
    act(() => {
      keyboardAction?.focus();
      keyboardAction?.click();
    });
    expect(document.body.textContent).toContain('x'.repeat(400));
    const target = document.activeElement ?? document.body;
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(useGitHubStore.getState().toasts).toHaveLength(1);
  });

  it('keeps the toast when Escape closes a full-message dialog opened by a click', () => {
    render();
    addToast(`First line\n${'x'.repeat(400)}`, 'error');

    const card = onlyCard();
    const keyboardAction = card.querySelector<HTMLButtonElement>(
      'button[aria-label="Read full notification"]',
    );
    // Focus inside the card must be handed off even for a card click.
    act(() => {
      keyboardAction?.focus();
      card.click();
    });
    expect(document.body.textContent).toContain('x'.repeat(400));
    expect(document.activeElement).not.toBe(keyboardAction);
    const target = document.activeElement ?? document.body;
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(useGitHubStore.getState().toasts).toHaveLength(1);
  });

  it('leaves a short message with nowhere to go as plain text', () => {
    render();
    addToast('Push complete');

    expect(onlyCard().getAttribute('role')).toBeNull();
  });

  it('opens the destination, not the full message, when a long toast has one', () => {
    const onClick = jest.fn();
    render();
    addToast(
      `First line\n${'x'.repeat(400)}`,
      'info',
      { category: 'Chat' },
      onClick,
    );

    act(() => onlyCard().click());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('x'.repeat(400));
  });

  it('opens the destination from the card but not from its buttons', () => {
    const onClick = jest.fn();
    render();
    addToast('Chat finished', 'info', { category: 'Chat' }, onClick);

    act(() => {
      onlyCard()
        .querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')
        ?.click();
    });
    expect(onClick).not.toHaveBeenCalled();

    addToast('Chat finished again', 'info', { category: 'Chat' }, onClick);
    const card = onlyCard();
    expect(card.getAttribute('role')).toBeNull();
    expect(
      card.querySelector('button[aria-label="Open notification"]'),
    ).not.toBeNull();
    act(() => card.click());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  function stackCards(): HTMLElement[] {
    return Array.from(
      container?.querySelectorAll<HTMLElement>(
        '[data-testid="toast-stack-card"]',
      ) ?? [],
    );
  }

  function swipe(target: HTMLElement, deltaX: number, deltaY = 0): WheelEvent {
    const event = new WheelEvent('wheel', {
      deltaX,
      deltaY,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('hides a toast swiped toward the screen edge on a trackpad, keeping its history', () => {
    render('top-right');
    addToast('Push complete');
    const [card] = stackCards();
    if (card === undefined) throw new Error('no card');

    // Fingers moving right scroll left: the card follows them.
    const first = swipe(card, -30);
    expect(first.defaultPrevented).toBe(true);
    expect(card.style.getPropertyValue('--toast-swipe-x')).toBe('30px');
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
    expect(useGitHubStore.getState().toasts).toHaveLength(1);

    swipe(card, -40);
    swipe(card, -40);
    expect(card.style.getPropertyValue('--toast-swipe-x')).toBe('110px');
    // Nothing is decided while the fingers move; the swipe ends past the line.
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
    act(() => jest.advanceTimersByTime(400));
    expect(useGitHubStore.getState().toasts).toEqual([]);
    expect(useGitHubStore.getState().notifications).toHaveLength(1);
  });

  it('hides one toast per trackpad swipe, however long its momentum runs', () => {
    render('top-right');
    addToast('One');
    addToast('Two');
    const [front, behind] = stackCards();
    if (front === undefined || behind === undefined) throw new Error('no card');

    // A flick: the fingers lift and the momentum decays. The front card
    // slides out from under the pointer, so the swipe lands on the card
    // behind it and still carries the front one.
    swipe(front, -40);
    for (const deltaX of [-40, -30, -20, -10]) {
      act(() => jest.advanceTimersByTime(16));
      swipe(behind, deltaX);
    }
    expect(front.hasAttribute('data-swipe-flung')).toBe(true);
    expect(behind.style.getPropertyValue('--toast-swipe-x')).toBe('');

    // The rest of the momentum, over the next card, leaves it alone.
    swipe(behind, -8);
    swipe(behind, -6);
    expect(behind.style.getPropertyValue('--toast-swipe-x')).toBe('');
    act(() => jest.advanceTimersByTime(400));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);

    // A new swipe, after the momentum has stopped, hides the next one.
    swipe(behind, -60);
    swipe(behind, -60);
    act(() => jest.advanceTimersByTime(400));
    expect(useGitHubStore.getState().toasts).toEqual([]);
  });

  it('lets a short trackpad swipe settle back and leaves vertical scrolling alone', () => {
    render('top-right');
    addToast('Push complete');
    const [card] = stackCards();
    if (card === undefined) throw new Error('no card');

    expect(swipe(card, -10, 80).defaultPrevented).toBe(false);
    // Away from the edge: the card resists.
    swipe(card, 200);
    const pulled = Number.parseFloat(
      card.style.getPropertyValue('--toast-swipe-x'),
    );
    expect(pulled).toBeLessThan(0);
    expect(pulled).toBeGreaterThan(-200 * 0.55);
    swipe(card, -30);
    act(() => jest.advanceTimersByTime(1000));

    expect(card.style.getPropertyValue('--toast-swipe-x')).toBe('');
    expect(card.hasAttribute('data-swipe-dragging')).toBe(false);
    expect(card.hasAttribute('data-swipe-settling')).toBe(false);
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
  });

  it('marks the stack so the in-app browser view steps aside while a toast is up', () => {
    render();
    const host = container?.querySelector('[data-testid="toast-stack-host"]');
    expect(host?.hasAttribute('data-canopy-browser-native-overlay')).toBe(
      false,
    );

    addToast('Push complete');
    expect(host?.getAttribute('data-canopy-browser-native-overlay')).toBe(
      'true',
    );
  });

  it('shows the newest three and brings older ones back as they leave', () => {
    render();
    addToast('One');
    addToast('Two');
    addToast('Three');
    addToast('Four');

    const visible = cards()
      .filter((card) => !card.closest('[data-limited]'))
      .map((card) => card.textContent);
    expect(visible).toEqual([
      expect.stringContaining('Four'),
      expect.stringContaining('Three'),
      expect.stringContaining('Two'),
    ]);
  });

  it('retains the stack when an old saved false choice arrives', () => {
    render();
    addToast('Push complete');

    act(() => {
      setStackEnabled(false);
    });

    const region = container?.querySelector(
      '[data-testid="toast-live-region"]',
    );
    expect(region?.getAttribute('role')).toBe('region');
    expect(cards()).toHaveLength(1);
    expect(container?.querySelector('button[aria-label="Expand"]')).toBeNull();
  });

  it('keeps pause and resume timing when a retired false choice arrives', () => {
    render();
    addToast('Push complete', 'info');
    act(() => {
      onlyCard().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // The store's own timer fires while the stack holds the clock.
    act(() => jest.advanceTimersByTime(TOAST_LIFETIME_MS * 2));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);

    act(() => {
      setStackEnabled(false);
    });
    act(() => {
      onlyCard().dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    act(() => jest.advanceTimersByTime(TOAST_LIFETIME_MS - 1));
    expect(useGitHubStore.getState().toasts).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));

    expect(useGitHubStore.getState().toasts).toEqual([]);
    expect(
      useGitHubStore.getState().notifications.map((entry) => entry.message),
    ).toEqual(['Push complete']);
  });
});
