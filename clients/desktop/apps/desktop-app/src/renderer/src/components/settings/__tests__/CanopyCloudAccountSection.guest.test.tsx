/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useGitHubStore, type Toast } from '@/stores/githubStore';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { CanopyCloudAccountSection } from '../CanopyCloudAccountSection';

// Stub the telemetry children so this focused test only exercises the account
// identity / connection branches (they self-fetch entitlements otherwise).
jest.mock('../TelemetrySharingControls', () => ({
  TelemetrySharingControls: (): JSX.Element => <></>,
}));
jest.mock('../TelemetrySharingIntro', () => ({
  TelemetrySharingIntro: (): JSX.Element => <></>,
}));

const GUEST_SYNTHETIC_EMAIL =
  'guest+32bce771-85a6-4535-b0c3-15eab9be71e1@guest.canopy.invalid';

// A normalized guest: `authMode: 'guest'` with `credentialSource` normalized to
// 'manual' (the account store's fallback for unrecognized values). This is the
// state that would otherwise satisfy `isManualOrLegacyCloudCredential` and leak
// the synthetic email under the API Key tab.
const NORMALIZED_GUEST: CanopyCloudAccountPublicState = {
  hasApiKey: true,
  authMode: 'guest',
  credentialSource: 'manual',
  capabilities: [],
  storageAvailable: true,
  account: {
    id: 'guest-1',
    name: 'Guest',
    email: GUEST_SYNTHETIC_EMAIL,
    role: 'DEVELOPER',
  },
};

describe('CanopyCloudAccountSection — guest identity', () => {
  let container: HTMLElement;
  let root: Root;
  let addedToasts: Toast[];
  const startCanopyCloudOAuthLogin = jest.fn();
  const loadCanopyCloudAccount = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    addedToasts = [];
    loadCanopyCloudAccount.mockResolvedValue(NORMALIZED_GUEST);
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: {
        authenticated: true,
        account: {
          id: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
        capabilities: ['portal-v1'],
        missingCapabilities: [],
        error: null,
      },
      account: {
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
      },
    });
    useGitHubStore.setState({
      addToast: (message, type, onClick, meta): void => {
        addedToasts.push({
          id: `toast-${addedToasts.length}`,
          message,
          type,
          onClick,
          createdAt: 0,
          meta,
        });
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount,
        loadCanopyCloudApiKey: jest.fn().mockResolvedValue(null),
        loadPreferences: jest
          .fn()
          .mockResolvedValue(
            makeTestPreferences({ telemetrySharingPromptSeen: true }),
          ),
        savePreferences: jest.fn().mockResolvedValue(undefined),
        startCanopyCloudOAuthLogin,
        cancelCanopyCloudOAuthLogin: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    jest.clearAllMocks();
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<CanopyCloudAccountSection />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  it('never renders the synthetic guest email or the non-merging API-key fallback', async () => {
    await render();
    expect(container.textContent).not.toContain('guest.canopy.invalid');
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
      ),
    ).toBeNull();
  });

  it.each([
    {
      mode: 'OAuth',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      testId: 'settings-account-canopy-cloud-oauth',
    },
    {
      mode: 'API key',
      authMode: 'api_key',
      credentialSource: 'manual',
      testId: 'settings-account-canopy-cloud-api-key',
    },
  ] as const)(
    'blocks only the signed-in name and email from session replay ($mode)',
    async ({ authMode, credentialSource, testId }) => {
      loadCanopyCloudAccount.mockResolvedValue({
        hasApiKey: true,
        authMode,
        credentialSource,
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Alice Example',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
      });
      await render();

      const status = container.querySelector(`[data-testid="${testId}"]`);
      expect(status?.textContent).toBe(
        'Signed in as Alice Example (alice@example.com)',
      );
      expect(outermostReplayBlock(status)).toBeNull();
      expectReplayBlocksOnlyValue(container, 'Alice Example');
      expectReplayBlocksOnlyValue(container, 'alice@example.com');
    },
  );

  it('warns when guest OAuth succeeds without a confirmed merge', async () => {
    await render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.type).toBe('warning');
    expect(addedToasts[0]?.message).toContain("couldn't sync your guest work");
  });

  it('treats an explicit merge failure as conclusive when the cached account was not a guest', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    });
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: {
        authenticated: true,
        account: {
          id: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
        capabilities: ['portal-v1'],
        missingCapabilities: [],
        error: null,
      },
      account: {
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
      },
      guestDataMerged: false,
    });
    await render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.type).toBe('warning');
  });
});
