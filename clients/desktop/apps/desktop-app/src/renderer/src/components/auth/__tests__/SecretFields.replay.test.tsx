/** @jest-environment jsdom */
jest.mock('@/hooks/useGitHubCliStatus', () => ({
  invalidateGitHubCliStatusCache: jest.fn(),
  useGitHubCliStatus: (): { authenticated: boolean } => ({
    authenticated: false,
  }),
}));
jest.mock('@/hooks/useGitHubPermissions', () => ({
  invalidateGitHubPermissionsCache: jest.fn(),
  useGitHubPermissions: (): null => null,
}));
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CanopyCloudApiKeyField } from '../CanopyCloudApiKeyField';
import { ProviderAuthPanel } from '../ProviderAuthPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BLOCK_SELECTOR = `.${POSTHOG_REPLAY_BLOCK_CLASS}`;

describe('secret fields in session replay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousApi = Object.getOwnPropertyDescriptor(window, 'api');
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

  it('records the Canopy Cloud API key field (the recorder masks its value)', () => {
    act(() =>
      root.render(
        <CanopyCloudApiKeyField
          value="csk_secret"
          onChange={(): void => undefined}
          visible={true}
          onToggleVisible={(): void => undefined}
        />,
      ),
    );
    const input = container.querySelector(
      '[data-testid="settings-account-canopy-cloud-api-key-input"]',
    );
    expect(input).not.toBeNull();
    expect(input?.closest(BLOCK_SELECTOR)).toBeNull();
    expect(container.querySelector(BLOCK_SELECTOR)).toBeNull();
  });

  it('records the GitHub personal access token input (the recorder masks its value)', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadGitHubPat: jest.fn().mockResolvedValue('ghp_secret'),
        saveGitHubPat: jest.fn().mockResolvedValue({ success: true }),
        refreshGitHubCredentials: jest.fn().mockResolvedValue(undefined),
      },
    });
    await act(async () => {
      root.render(<ProviderAuthPanel provider="github" layout="panel" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = container.querySelector(
      'input[data-testid="auth-panel-github-pat-input"]',
    );
    expect(input).not.toBeNull();
    expect(input?.closest(BLOCK_SELECTOR)).toBeNull();
  });
});
