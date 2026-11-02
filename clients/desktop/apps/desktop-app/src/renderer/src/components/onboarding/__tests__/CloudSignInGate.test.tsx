/**
 * Renderer tests run in the node Jest environment without
 * @testing-library/react, so we use renderToStaticMarkup (matching the repo's
 * renderer test pattern). To exercise the onConnected wiring we stub the
 * embedded CloudAuthPanel with a mock that invokes its onConnectSuccess prop
 * during render, driven by a module-level toggle.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { CanopyCloudConnectSuccess } from '@/components/auth/useCanopyCloudAuth';
import { useGitHubStore } from '@/stores/githubStore';
import { CloudSignInGate } from '../CloudSignInGate';

jest.mock('@/lib/brand', () => ({
  brand: {
    displayName: 'Mock App',
    assets: {
      logoSvg: '<svg><path d="M0 0"/></svg>',
    },
  },
  brandText: { appName: 'Mock App' },
}));

let mockReportConnected = false;
let mockLocalPlatform: NodeJS.Platform = 'darwin';
jest.mock('@/lib/local-platform', () => ({
  localPlatform: (): NodeJS.Platform => mockLocalPlatform,
}));
let mockReportReady = false;
let receivedOnConnectedChange = false;
let receivedBenefits: Array<{ label: string }> | undefined;
let mockConnectResult: CanopyCloudConnectSuccess | null = null;

jest.mock('@/components/auth/CloudAuthPanel', () => ({
  DEFAULT_CLOUD_AUTH_BENEFITS: [
    { id: 'keep-work', label: 'Keep your work synced to your account' },
    { id: 'reach-agents', label: 'Reach your agents anywhere' },
  ],
  CloudAuthPanel: ({
    onConnectSuccess,
    onReadyToContinue,
    onConnectedChange,
    benefits,
  }: {
    onConnectSuccess?: (result: CanopyCloudConnectSuccess) => void;
    onReadyToContinue?: () => void;
    onConnectedChange?: (connected: boolean) => void;
    benefits?: Array<{ label: string }>;
  }): JSX.Element => {
    receivedOnConnectedChange = onConnectedChange !== undefined;
    receivedBenefits = benefits;
    if (mockReportConnected && mockConnectResult) {
      onConnectSuccess?.(mockConnectResult);
    }
    if (mockReportReady) onReadyToContinue?.();
    return <div data-testid="mock-account-section" />;
  },
}));

describe('CloudSignInGate', () => {
  beforeEach(() => {
    mockLocalPlatform = 'darwin';
    mockReportConnected = false;
    mockReportReady = false;
    receivedOnConnectedChange = false;
    receivedBenefits = undefined;
    mockConnectResult = {
      mode: 'oauth',
      account: {
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: [],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'ADMIN',
        },
      },
      replacedManualKey: false,
      upgradedFromGuest: false,
    };
  });

  test.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'keeps the sign-in content but only adds an empty strip without a %s native frame',
    (platform) => {
      mockLocalPlatform = platform;
      const html = renderToStaticMarkup(
        <CloudSignInGate onConnected={() => {}} />,
      );
      expect(html.includes('electron-drag h-10 shrink-0 w-full')).toBe(
        platform !== 'linux',
      );
      expect(html).toContain('data-testid="mock-account-section"');
    },
  );

  test('renders the blocking gate with the welcome copy and account panel', () => {
    const html = renderToStaticMarkup(
      <CloudSignInGate onConnected={() => {}} />,
    );
    expect(html).toContain('data-testid="cloud-sign-in-gate"');
    expect(html).toContain('Welcome to Mock App');
    expect(html).toContain('Connect your account to start building.');
    expect(html).toContain('data-testid="mock-account-section"');
    // Window stays draggable behind the splash.
    expect(html).toContain('electron-drag');
    // The gate uses the panel's neutral defaults rather than overriding them
    // with guest-specific reassurance.
    expect(receivedBenefits).toBeUndefined();
  });

  test('invokes onConnected when the account panel reports a connection', () => {
    const onConnected = jest.fn();
    mockReportConnected = true;
    renderToStaticMarkup(<CloudSignInGate onConnected={onConnected} />);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(receivedOnConnectedChange).toBe(false);
  });

  test('warns before continuing when an explicit guest merge failure is reported', () => {
    const addToast = jest.fn();
    useGitHubStore.setState({ addToast });
    const onConnected = jest.fn();
    mockReportConnected = true;
    expect(mockConnectResult).not.toBeNull();
    if (!mockConnectResult) return;
    mockConnectResult = {
      ...mockConnectResult,
      guestDataMerged: false,
    };

    renderToStaticMarkup(<CloudSignInGate onConnected={onConnected} />);

    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("couldn't sync your guest work"),
      'warning',
      undefined,
      expect.objectContaining({ title: 'Guest work not synced' }),
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  test('does not invoke onConnected while the account stays disconnected', () => {
    const onConnected = jest.fn();
    mockReportConnected = false;
    renderToStaticMarkup(<CloudSignInGate onConnected={onConnected} />);
    expect(onConnected).not.toHaveBeenCalled();
  });

  test('invokes onConnected when an existing account settles ready to continue', () => {
    const onConnected = jest.fn();
    mockReportReady = true;
    renderToStaticMarkup(<CloudSignInGate onConnected={onConnected} />);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
