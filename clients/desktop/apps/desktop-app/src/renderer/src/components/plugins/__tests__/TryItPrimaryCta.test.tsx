/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { TryItCapability } from '@canopy/protocol/try-it';
import { TryItPrimaryCta, type TryItPrimaryCtaProps } from '../TryItPrimaryCta';

const mockStartTryItChat = jest.fn();
jest.mock('@/lib/tryItChat', () => ({
  startTryItChat: (...args: unknown[]): unknown => mockStartTryItChat(...args),
}));
let mockClaudeAuth: { authenticated: boolean } | null = null;
let mockCodexAuth: { authenticated: boolean } | null = null;
jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): unknown => mockClaudeAuth,
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): unknown => mockCodexAuth,
}));
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => false,
}));
const mockCodexModel = { model: 'gpt-5.5', thinkingLevel: 'medium' };
const mockChatState = {
  modelDefaults: {
    chatProvider: 'claude',
    chatModelByProvider: {
      claude: { model: 'opus', thinkingLevel: 'high' },
      codex: mockCodexModel,
      ollama: null,
    },
  },
  ensureModelDefaultsLoaded: jest.fn(() => Promise.resolve()),
};
jest.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (select: (state: unknown) => unknown): unknown => select(mockChatState),
    { getState: (): unknown => mockChatState },
  ),
}));
const mockAddToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: mockAddToast }),
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const signedIn = {
  hasApiKey: true,
  authMode: 'oauth',
  credentialSource: 'oauth_desktop',
  capabilities: [],
  storageAvailable: true,
  account: {
    id: 'acct-1',
    name: 'Test',
    email: 't@example.com',
    role: 'DEVELOPER',
  },
};
const signedOut = {
  hasApiKey: false,
  authMode: null,
  credentialSource: null,
  capabilities: [],
  storageAvailable: true,
  read: 'ok',
};

const capability: TryItCapability = {
  kind: 'plugin',
  sourceId: 'curated/cloud',
  catalogId: 'linear',
  name: 'Linear',
};

let container: HTMLDivElement;
let root: Root;
let loadAccount: jest.Mock;
let originalApi: unknown;

beforeEach(() => {
  mockClaudeAuth = null;
  mockCodexAuth = null;
  mockStartTryItChat.mockReset().mockResolvedValue(undefined);
  mockAddToast.mockReset();
  loadAccount = jest.fn().mockResolvedValue(signedOut);
  originalApi = Reflect.get(window, 'api');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAccount: loadAccount },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: originalApi,
  });
});

async function render(
  props: Partial<TryItPrimaryCtaProps> = {},
): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(
      <TryItPrimaryCta
        capability={capability}
        prompt="Summarize my open Linear issues."
        installation="not-installed"
        onInstall={(): void => {}}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return cta();
}

function cta(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="detail-primary-cta"]',
  );
  if (!button) throw new Error('CTA not rendered');
  return button;
}

/** Clicks and lets the launch's promise chain settle. */
async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeAccount(account: object): Promise<void> {
  loadAccount.mockResolvedValue(account);
  await act(async () => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    await Promise.resolve();
  });
}

describe('TryItPrimaryCta', () => {
  it('is a disabled Try it until the account read settles', async () => {
    loadAccount.mockReturnValue(new Promise(() => {}));
    const button = await render();
    expect(button.dataset.state).toBe('pending');
    expect(button.textContent).toBe('Try it');
    expect(button.disabled).toBe(true);
  });

  it('offers a guest Try it for an uninstalled capability', async () => {
    const button = await render();
    expect(button.dataset.state).toBe('try');
    await press(button);
    expect(mockStartTryItChat).toHaveBeenCalledTimes(1);
    expect(mockStartTryItChat).toHaveBeenCalledWith({
      accountId: 'guest',
      capability,
      prompt: 'Summarize my open Linear issues.',
      runtimeSelections: undefined,
    });
  });

  it('follows sign-in and sign-out in place', async () => {
    const onInstall = jest.fn();
    await render({ onInstall });
    expect(cta().dataset.state).toBe('try');

    await changeAccount(signedIn);
    expect(cta().dataset.state).toBe('install');
    expect(cta().textContent).toBe('Install');
    await press(cta());
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(mockStartTryItChat).not.toHaveBeenCalled();

    await changeAccount(signedOut);
    expect(cta().dataset.state).toBe('try');
  });

  it('switches to Try it when installation completes', async () => {
    loadAccount.mockResolvedValue(signedIn);
    await render();
    expect(cta().dataset.state).toBe('install');
    await render({ installation: 'installed' });
    expect(cta().dataset.state).toBe('try');
    await press(cta());
    expect(mockStartTryItChat).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account:acct-1' }),
    );
  });

  it('disables Try it while a connection is pending', async () => {
    loadAccount.mockResolvedValue(signedIn);
    const button = await render({ installation: 'pending' });
    expect(button.dataset.state).toBe('pending');
    expect(button.disabled).toBe(true);
  });

  it('blocks a second activation while the chat opens', async () => {
    let finish: () => void = () => {};
    mockStartTryItChat.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await press(cta());
    expect(cta().textContent).toBe('Opening chat…');
    expect(cta().disabled).toBe(true);
    await press(cta());
    expect(mockStartTryItChat).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(cta().disabled).toBe(false);
  });

  it("keeps a signed-out viewer's local install beside Try it", async () => {
    const guestInstall = <button data-testid="guest-install">Install</button>;
    await render({ guestInstallAction: guestInstall });
    expect(
      container.querySelector('[data-testid="guest-install"]'),
    ).not.toBeNull();
    expect(cta().dataset.state).toBe('try');

    await changeAccount(signedIn);
    // Signed in, Install is the primary itself, so the secondary goes.
    expect(container.querySelector('[data-testid="guest-install"]')).toBeNull();
    expect(cta().dataset.state).toBe('install');

    await changeAccount(signedOut);
    await render({
      guestInstallAction: guestInstall,
      installation: 'installed',
    });
    expect(container.querySelector('[data-testid="guest-install"]')).toBeNull();
  });

  it('starts a Claude-unsupported capability on the signed-in Codex model', async () => {
    mockClaudeAuth = { authenticated: true };
    mockCodexAuth = { authenticated: true };
    await render({
      installation: 'installed',
      harnessSupport: { claude: false, codex: true, cursor: false },
    });
    expect(cta().dataset.state).toBe('try');
    await press(cta());
    expect(mockStartTryItChat).toHaveBeenCalledWith(
      expect.objectContaining({ capability, model: mockCodexModel }),
    );
  });

  it('keeps the default model when the default harness is supported', async () => {
    await render({
      installation: 'installed',
      harnessSupport: { claude: true, codex: false, cursor: false },
    });
    await press(cta());
    // Exact: no `model`, so the chat keeps the viewer's default.
    expect(mockStartTryItChat).toHaveBeenCalledWith({
      accountId: 'guest',
      capability,
      prompt: 'Summarize my open Linear issues.',
      runtimeSelections: undefined,
    });
  });

  it.each([
    ['guest', signedOut, 'not-installed'],
    ['signed-in', signedIn, 'installed'],
  ] as const)(
    'launches before harness authentication without installing for %s',
    async (_name, account, installation) => {
      loadAccount.mockResolvedValue(account);
      mockClaudeAuth = { authenticated: true };
      mockCodexAuth = { authenticated: false };
      const onInstall = jest.fn();
      await render({
        installation,
        onInstall,
        harnessSupport: { claude: false, codex: true, cursor: false },
      });
      expect(cta().dataset.state).toBe('try');
      expect(cta().textContent).toBe('Try it');
      await press(cta());
      expect(mockStartTryItChat).toHaveBeenCalledWith(
        expect.objectContaining({
          capability,
          prompt: 'Summarize my open Linear issues.',
          model: mockCodexModel,
        }),
      );
      expect(onInstall).not.toHaveBeenCalled();
    },
  );

  it('reports a failed launch and stays retryable', async () => {
    mockStartTryItChat.mockRejectedValueOnce(new Error('offline'));
    await render();
    await press(cta());
    expect(mockAddToast).toHaveBeenCalledWith(
      "Couldn't open the chat. Try again.",
      'error',
    );
    expect(cta().disabled).toBe(false);
  });
});
