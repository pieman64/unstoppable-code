/** @jest-environment jsdom */
jest.mock('@/hooks/useGitHubCliStatus', () => ({
  invalidateGitHubCliStatusCache: jest.fn(),
  useGitHubCliStatus: (): Record<string, unknown> => ({
    authenticated: true,
    username: 'octo-user',
    error: null,
    tokenSource: null,
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: true,
  }),
}));
jest.mock('@/hooks/useGitHubPermissions', () => ({
  invalidateGitHubPermissionsCache: jest.fn(),
  useGitHubPermissions: jest.fn((): null => null),
}));
const SIGNED_IN_CLAUDE: Record<string, unknown> = {
  authenticated: true,
  accountLabel: 'claude@example.com',
  detail: 'claude.ai (max)',
  error: null,
};
let mockClaudeStatus: Record<string, unknown> = SIGNED_IN_CLAUDE;
jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  invalidateClaudeAuthStatusCache: jest.fn(),
  useClaudeAuthStatus: (): Record<string, unknown> => mockClaudeStatus,
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  invalidateCodexAuthStatusCache: jest.fn(),
  useCodexAuthStatus: (): null => null,
}));
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));
let mockCarryover: {
  provider: 'claude' | 'codex' | 'cursor';
  skills: number;
  commands: number;
  plugins: number;
  attention: string[];
} | null = null;
const mockUseProviderCarryover = jest.fn<
  typeof mockCarryover,
  [string, boolean, number | undefined]
>(() => mockCarryover);
jest.mock('@/hooks/useProviderCarryover', () => ({
  useProviderCarryover: (
    provider: string,
    enabled: boolean,
    refreshKey?: number,
  ): typeof mockCarryover =>
    mockUseProviderCarryover(provider, enabled, refreshKey),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProviderAuthPanel } from '../ProviderAuthPanel';
import {
  invalidateGitHubPermissionsCache,
  useGitHubPermissions,
} from '@/hooks/useGitHubPermissions';
import { GITHUB_CONNECTION_CHANGED_EVENT } from '@/lib/integrationConnectionEvents';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ProviderAuthPanel account labels', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClaudeStatus = SIGNED_IN_CLAUDE;
    previousApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadGitHubPat: jest.fn().mockResolvedValue(''),
        saveGitHubPat: jest.fn().mockResolvedValue({ success: true }),
        refreshGitHubCredentials: jest.fn().mockResolvedValue(undefined),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (previousApi) Object.defineProperty(window, 'api', previousApi);
    else Reflect.deleteProperty(window, 'api');
  });

  async function render(element: JSX.Element): Promise<void> {
    await act(async () => {
      root.render(element);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it.each(['ghp_recovered_fixture', ''])(
    'refreshes permissions and listeners only after a failed PAT read recovers (%s)',
    async (token) => {
      const failure = {
        success: false,
        error: 'Storage is locked',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      };
      const load = jest
        .fn()
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce(failure)
        .mockResolvedValue(token);
      Object.assign(window.api, { loadGitHubPat: load });
      const changed = jest.fn();
      window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, changed);
      try {
        await render(<ProviderAuthPanel provider="github" layout="row" />);
        expect(changed).not.toHaveBeenCalled();
        expect(invalidateGitHubPermissionsCache).not.toHaveBeenCalled();
        expect(useGitHubPermissions).toHaveBeenLastCalledWith('oauth', 0);
        const retry = container.querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        );
        if (!retry) throw new Error('Read retry missing');
        await act(async () => {
          await Promise.resolve();
          retry.click();
        });
        expect(changed).not.toHaveBeenCalled();
        expect(invalidateGitHubPermissionsCache).not.toHaveBeenCalled();
        expect(useGitHubPermissions).toHaveBeenLastCalledWith('oauth', 0);
        await act(async () => {
          await Promise.resolve();
          retry.click();
        });
        expect(
          container.querySelector('[data-testid="secure-storage-notice"]'),
        ).toBeNull();
        expect(window.api.saveGitHubPat).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledTimes(1);
        expect(invalidateGitHubPermissionsCache).toHaveBeenCalledTimes(1);
        expect(useGitHubPermissions).toHaveBeenLastCalledWith('oauth', 1);
        await act(async () => {
          await Promise.resolve();
          root.render(null);
        });
        await render(<ProviderAuthPanel provider="github" layout="row" />);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(invalidateGitHubPermissionsCache).toHaveBeenCalledTimes(1);
        expect(useGitHubPermissions).toHaveBeenLastCalledWith(
          token ? 'pat' : 'oauth',
          0,
        );
      } finally {
        window.removeEventListener(GITHUB_CONNECTION_CHANGED_EVENT, changed);
      }
    },
  );

  it('queues the validated OAuth clear after an in-flight PAT save on unmount', async () => {
    jest.useFakeTimers();
    let finishSave: (result: { success: boolean }) => void = () => undefined;
    const pendingSave = new Promise<{ success: boolean }>((resolve) => {
      finishSave = resolve;
    });
    const save = jest
      .fn()
      .mockReturnValueOnce(pendingSave)
      .mockResolvedValue({ success: true });
    Object.assign(window.api, {
      loadGitHubPat: jest.fn().mockResolvedValue('old-key'),
      saveGitHubPat: save,
    });
    try {
      await render(<ProviderAuthPanel provider="github" layout="row" />);
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="auth-panel-github-pat-input"]',
      );
      if (!input) throw new Error('PAT input missing');
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      if (!descriptor?.set) throw new Error('Input value setter missing');
      act(() => {
        descriptor.set?.call(input, 'new-key');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
        await Promise.resolve();
      });
      expect(save).toHaveBeenNthCalledWith(1, 'new-key');
      const oauth = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'CLI managed',
      );
      await act(async () => {
        oauth?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Stored PAT will be removed');
      act(() => root.render(null));
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishSave({ success: true });
        await pendingSave;
        await Promise.resolve();
      });
      expect(save).toHaveBeenNthCalledWith(2, '');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['row', 'panel'] as const)(
    'shows the signed-in GitHub username in the %s layout',
    async (layout) => {
      await render(<ProviderAuthPanel provider="github" layout={layout} />);
      expect(container.textContent).toContain('Signed in as octo-user');
    },
  );

  it.each(['row', 'panel'] as const)(
    'tells a signed-in Claude user what carried over in the %s layout',
    async (layout) => {
      mockCarryover = {
        provider: 'claude',
        skills: 2,
        commands: 1,
        plugins: 1,
        attention: ['~/.claude/skills/broken'],
      };
      try {
        await render(<ProviderAuthPanel provider="claude" layout={layout} />);
        const note = container.querySelector(
          '[data-testid="provider-carryover-claude"]',
        );
        expect(note?.textContent).toContain(
          '2 skills, 1 command, and 1 plugin ready',
        );
        expect(
          container.querySelector(
            '[data-testid="provider-carryover-claude-attention"]',
          )?.textContent,
        ).toBe("Couldn't load ~/.claude/skills/broken.");
        // Read for the signed-in provider only; Codex is signed out here.
        expect(mockUseProviderCarryover).toHaveBeenCalledWith(
          'claude',
          true,
          expect.any(Number),
        );
      } finally {
        mockCarryover = null;
      }
    },
  );

  it('shows nothing about carry-over while the provider is signed out', async () => {
    await render(<ProviderAuthPanel provider="codex" layout="row" />);
    expect(mockUseProviderCarryover).toHaveBeenCalledWith(
      'codex',
      false,
      expect.any(Number),
    );
    expect(
      container.querySelector('[data-testid="provider-carryover-codex"]'),
    ).toBeNull();
  });

  it.each(['row', 'panel'] as const)(
    'shows the signed-in Claude account label in the %s layout',
    async (layout) => {
      await render(<ProviderAuthPanel provider="claude" layout={layout} />);
      // The row leads with the account; the panel keeps its prefix.
      expect(container.textContent).toContain(
        layout === 'row'
          ? 'claude@example.com · '
          : 'Signed in as claude@example.com',
      );
    },
  );

  it.each([
    { provider: 'github', layout: 'row', identity: 'octo-user' },
    { provider: 'github', layout: 'panel', identity: 'octo-user' },
    { provider: 'claude', layout: 'row', identity: 'claude@example.com' },
    { provider: 'claude', layout: 'panel', identity: 'claude@example.com' },
  ] as const)(
    'blocks only the $provider account from session replay in the $layout layout',
    async ({ provider, layout, identity }) => {
      await render(<ProviderAuthPanel provider={provider} layout={layout} />);
      expectReplayBlocksOnlyValue(container, identity);
      // The surrounding copy and the account action stay recorded.
      // The innermost line that holds the account beside other copy.
      const signedInCopy = Array.from(container.querySelectorAll('*'))
        .reverse()
        .find(
          (element) =>
            element.children.length > 0 &&
            element.textContent?.includes(identity) === true &&
            element.textContent !== identity,
        );
      expect(signedInCopy).toBeDefined();
      expect(outermostReplayBlock(signedInCopy)).toBeNull();
      const connect = container.querySelector(
        `[data-testid="auth-panel-${provider}-connect"]`,
      );
      expect(connect).not.toBeNull();
      expect(outermostReplayBlock(connect)).toBeNull();
    },
  );

  describe('neutral unauthenticated tone', () => {
    function claudeRow(): HTMLElement {
      const row = container.querySelector<HTMLElement>(
        '[data-testid="auth-panel-claude"]',
      );
      if (!row) throw new Error('Claude row missing');
      return row;
    }

    function connectButton(): HTMLButtonElement {
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="auth-panel-claude-connect"]',
      );
      if (!button) throw new Error('Claude connect button missing');
      return button;
    }

    function statusDot(): HTMLElement {
      const dot = claudeRow().querySelector<HTMLElement>('.rounded-full');
      if (!dot) throw new Error('Status dot missing');
      return dot;
    }

    it.each([null, 'Claude is not authenticated.'])(
      'shows a signed-out row (error %s) as Not connected with a Connect button and no alarm colour',
      async (error) => {
        // Main reports a plain sign-out with its own generic error; the neutral
        // row reads it as a normal choice, not a failure.
        mockClaudeStatus = {
          authenticated: false,
          error,
          probeFailed: false,
        };
        await render(
          <ProviderAuthPanel
            provider="claude"
            layout="row"
            unauthenticatedTone="neutral"
          />,
        );
        expect(claudeRow().textContent).toContain('Not connected');
        expect(claudeRow().textContent).not.toContain('is not authenticated');
        expect(connectButton().textContent).toBe('Connect');
        expect(
          claudeRow().querySelectorAll(
            '[class*="destructive"], [class*="warning"]',
          ),
        ).toHaveLength(0);
        expect(statusDot().className).toContain('border');
        expect(statusDot().className).not.toContain('bg-destructive');
      },
    );

    it("shows a failed check's own message in grey with Connect", async () => {
      mockClaudeStatus = {
        authenticated: false,
        error: 'Could not verify Claude authentication.',
        probeFailed: true,
      };
      await render(
        <ProviderAuthPanel
          provider="claude"
          layout="row"
          unauthenticatedTone="neutral"
        />,
      );
      const message = Array.from(claudeRow().querySelectorAll('span')).find(
        (element) =>
          element.textContent === 'Could not verify Claude authentication.',
      );
      expect(message?.className).toContain('fg-secondary');
      expect(connectButton().textContent).toBe('Connect');
      expect(
        claudeRow().querySelectorAll(
          '[class*="destructive"], [class*="warning"]',
        ),
      ).toHaveLength(0);
    });

    it('renders a signed-in row unchanged', async () => {
      await render(
        <ProviderAuthPanel
          provider="claude"
          layout="row"
          unauthenticatedTone="neutral"
        />,
      );
      expect(connectButton().textContent).toBe('Change account');
      expect(statusDot().className).toContain('bg-success');
    });

    it('keeps the default tone red with Sign in', async () => {
      mockClaudeStatus = {
        authenticated: false,
        error: null,
        probeFailed: false,
      };
      await render(<ProviderAuthPanel provider="claude" layout="row" />);
      expect(claudeRow().querySelector('.fg-destructive')?.textContent).toBe(
        'Claude is not authenticated.',
      );
      expect(connectButton().textContent).toBe('Sign in');
      expect(statusDot().className).toContain('bg-destructive');
    });
  });
});
