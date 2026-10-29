/**
 * @jest-environment jsdom
 */
// Coverage for the DISPLAYED-section report `SettingsOverlay` publishes to
// `navigationStore.settingsActiveSection` (CAN-3117). The renderer's screen
// route is derived from that value, so what matters here is that every
// redirect the overlay applies — including the ones `resolveSettingsSection`
// does not own, and the ones that resolve after mount — is reflected, and that
// one Settings navigation reports exactly one section.
//
// The projection over this value is tested separately in
// `lib/instrumentation/__tests__/posthog-route-source.test.ts`.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsSection } from '@canopy/desktop-shared/types';
import { SettingsOverlay } from '../SettingsOverlay';
import { useNavigationStore } from '@/stores/navigationStore';

// Hosted settings are off unless a test supplies a client. The hosted host,
// rail and pages are their own suites' concern.
let mockHostedClient: object | null = null;
jest.mock('../hosted/hosted-settings-availability', () => ({
  useHostedSettingsClient: (): object | null => mockHostedClient,
  useHostedSettingsAvailable: (): boolean => mockHostedClient !== null,
  hostedSettingsOpenable: (): boolean => mockHostedClient !== null,
}));
jest.mock('../hosted/DesktopSettingsHost', () => ({
  DesktopHostedSettingsProvider: ({
    children,
  }: {
    children: ReactNode;
  }): ReactNode => children,
}));
jest.mock('../hosted/HostedSettingsNav', () => ({
  HostedSettingsNav: (): null => null,
}));
jest.mock('../hosted/HostedSettingsContent', () => ({
  HostedSettingsContent: (): JSX.Element => (
    <div data-testid="hosted-content" />
  ),
}));

jest.mock('../CanopyTab', () => ({
  CanopyTab: (): JSX.Element => <div data-testid="canopy-tab" />,
}));
jest.mock('../PerformanceTab', () => ({ PerformanceTab: (): null => null }));
jest.mock('../KeyboardShortcutsTab', () => ({
  KeyboardShortcutsTab: (): null => null,
}));
jest.mock('../DisplayTab', () => ({
  DisplayTab: (): JSX.Element => <div data-testid="display-tab" />,
}));
jest.mock('../NotificationsTab', () => ({
  NotificationsTab: (): null => null,
}));
jest.mock('../AccountTab', () => ({ AccountTab: (): null => null }));
jest.mock('../PrivacyTab', () => ({ PrivacyTab: (): null => null }));
jest.mock('../ChatTab', () => ({ ChatTab: (): null => null }));
jest.mock('../MemoryTab', () => ({ MemoryTab: (): null => null }));
jest.mock('../InstructionsTab', () => ({ InstructionsTab: (): null => null }));
jest.mock('../PluginsTab', () => ({ PluginsTab: (): null => null }));
jest.mock('../HarnessesTab', () => ({ HarnessesTab: (): null => null }));
jest.mock('../AppAdvisorTab', () => ({ AppAdvisorTab: (): null => null }));
jest.mock('../FilesTab', () => ({ FilesTab: (): null => null }));
jest.mock('../BrowserTab', () => ({ BrowserTab: (): null => null }));
jest.mock('../TerminalTab', () => ({ TerminalTab: (): null => null }));
jest.mock('../PlanDetectionTab', () => ({
  PlanDetectionTab: (): null => null,
}));
jest.mock('../DictationTab', () => ({ DictationTab: (): null => null }));
jest.mock('../CodexTab', () => ({ CodexTab: (): null => null }));
jest.mock('../ClaudeTab', () => ({ ClaudeTab: (): null => null }));
jest.mock('../OllamaTab', () => ({ OllamaTab: (): null => null }));
jest.mock('../GitTab', () => ({ GitTab: (): null => null }));
jest.mock('../ApplicationsTab', () => ({ ApplicationsTab: (): null => null }));
jest.mock('../McpTab', () => ({ McpTab: (): null => null }));
jest.mock('../ApprovalsTab', () => ({ ApprovalsTab: (): null => null }));
jest.mock('../ExperimentsTab', () => ({ ExperimentsTab: (): null => null }));
jest.mock('../LegalTab', () => ({ LegalTab: (): null => null }));

jest.mock('@/hooks/useCodeGraphExperimentEnabled', () => ({
  useCodeGraphExperimentEnabled: (): boolean => false,
}));
let claudeSettingsAvailable = true;
jest.mock('@/lib/claude-settings-availability', () => ({
  useClaudeSettingsAvailable: (): boolean => claudeSettingsAvailable,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(window, 'platform');
const originalOllamaEnabled = (
  globalThis as unknown as { __CANOPY_OLLAMA_ENABLED__?: boolean }
).__CANOPY_OLLAMA_ENABLED__;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

function setOllamaEnabled(enabled: boolean): void {
  (
    globalThis as unknown as { __CANOPY_OLLAMA_ENABLED__?: boolean }
  ).__CANOPY_OLLAMA_ENABLED__ = enabled;
}

function reportedSection(): SettingsSection | null {
  return useNavigationStore.getState().settingsActiveSection;
}

/**
 * Every value `settingsActiveSection` takes, in order, ignoring repeats. This
 * is the sequence the route projection turns into page views, so an extra
 * entry here IS the two-view flicker the ticket forbids.
 */
function trackReports(): {
  reports: (SettingsSection | null)[];
  stop: () => void;
} {
  const reports: (SettingsSection | null)[] = [];
  let previous = useNavigationStore.getState().settingsActiveSection;
  const stop = useNavigationStore.subscribe(() => {
    const next = useNavigationStore.getState().settingsActiveSection;
    if (next !== previous) {
      previous = next;
      reports.push(next);
    }
  });
  return { reports, stop };
}

interface Harness {
  root: Root;
  container: HTMLDivElement;
  render: (element: JSX.Element) => Promise<void>;
  destroy: () => void;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    root,
    container,
    render: async (element): Promise<void> => {
      await act(async () => {
        root.render(element);
        await Promise.resolve();
      });
    },
    destroy: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  mockHostedClient = null;
  claudeSettingsAvailable = true;
  setPlatform('darwin');
  setOllamaEnabled(true);
  useNavigationStore.setState({ settingsActiveSection: null });
});

afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(window, 'platform', originalPlatform);
  } else {
    Reflect.deleteProperty(window, 'platform');
  }
  (
    globalThis as unknown as { __CANOPY_OLLAMA_ENABLED__?: boolean }
  ).__CANOPY_OLLAMA_ENABLED__ = originalOllamaEnabled;
  useNavigationStore.setState({ settingsActiveSection: null });
});

describe('SettingsOverlay displayed-section reporting', () => {
  it('reports the requested section when it is honored', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="display" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('display');
    harness.destroy();
  });

  it('reports exactly one section for one Settings navigation', async () => {
    const harness = mount();
    // Open closed first so the component holds a previous session's section.
    await harness.render(
      <SettingsOverlay open initialSection="display" onClose={jest.fn()} />,
    );
    await harness.render(
      <SettingsOverlay
        open={false}
        initialSection={undefined}
        onClose={jest.fn()}
      />,
    );
    expect(reportedSection()).toBeNull();

    const tracked = trackReports();
    await harness.render(
      <SettingsOverlay open initialSection="mcp" onClose={jest.fn()} />,
    );
    tracked.stop();

    // Never `display` (the stale section) and never an intermediate value.
    expect(tracked.reports).toEqual(['mcp']);
    harness.destroy();
  });

  it('reports one section when a deep link retargets an already-open Settings', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="display" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('display');

    const tracked = trackReports();
    await harness.render(
      <SettingsOverlay open initialSection="account" onClose={jest.fn()} />,
    );
    tracked.stop();

    expect(tracked.reports).toEqual(['account']);
    harness.destroy();
  });

  // The redirect matrix. In every case the REQUESTED section differs from the
  // displayed one, so reporting the request would be wrong.
  it('reports canopy for dictation on a platform without voice dictation', async () => {
    setPlatform('win32');
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="dictation" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('canopy');
    harness.destroy();
  });

  it('reports dictation on a platform that supports it', async () => {
    setPlatform('darwin');
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="dictation" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('dictation');
    harness.destroy();
  });

  it('reports canopy for ollama on an unsupported platform', async () => {
    setOllamaEnabled(false);
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="ollama" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('canopy');
    harness.destroy();
  });

  it('reports canopy for claude when Claude settings are unavailable', async () => {
    claudeSettingsAvailable = false;
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="claude" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('canopy');
    harness.destroy();
  });

  it('reports privacy', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="privacy" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('privacy');
    harness.destroy();
  });

  it('reports canopy for an absent requested section', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection={undefined} onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('canopy');
    harness.destroy();
  });

  it('reports the migrated section for the legacy pipeline-advisor deep link', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay
        open
        // Legacy openers still send the pre-rename key; `resolveSettingsSection`
        // migrates it before anything is published.
        initialSection={'pipeline-advisor' as SettingsSection}
        onClose={jest.fn()}
      />,
    );
    expect(reportedSection()).toBe('app-advisor');
    harness.destroy();
  });

  it('follows a post-mount Claude availability change with no user action', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="claude" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('claude');

    const tracked = trackReports();
    claudeSettingsAvailable = false;
    await harness.render(
      <SettingsOverlay open initialSection="claude" onClose={jest.fn()} />,
    );
    tracked.stop();

    expect(tracked.reports).toEqual(['canopy']);
    harness.destroy();
  });

  it('clears the report when Settings closes without unmounting', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="display" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('display');

    await harness.render(
      <SettingsOverlay
        open={false}
        initialSection={undefined}
        onClose={jest.fn()}
      />,
    );
    // The overlay is mounted unconditionally from `App.tsx`, so this — not
    // unmount — is the path that actually runs on close.
    expect(
      harness.container.querySelector('[data-testid="settings-overlay"]'),
    ).not.toBeNull();
    expect(reportedSection()).toBeNull();
    harness.destroy();
  });

  it('publishes the environment section and stays open', async () => {
    const onClose = jest.fn();
    const harness = mount();
    const tracked = trackReports();
    await harness.render(
      <SettingsOverlay open initialSection="environment" onClose={onClose} />,
    );
    tracked.stop();

    expect(onClose).not.toHaveBeenCalled();
    expect(reportedSection()).toBe('environment');
    expect(tracked.reports).toEqual(['environment']);
    harness.destroy();
  });

  it('reports a user-driven section change once', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay open initialSection="display" onClose={jest.fn()} />,
    );
    expect(reportedSection()).toBe('display');

    const tracked = trackReports();
    const accountButton = harness.container.querySelector<HTMLElement>(
      '[data-testid="settings-nav-account"]',
    );
    expect(accountButton).not.toBeNull();
    await act(async () => {
      accountButton?.click();
      await Promise.resolve();
    });
    tracked.stop();

    expect(tracked.reports).toEqual(['account']);
    harness.destroy();
  });

  it('reports hosted Notifications for a Notifications request with hosted settings', async () => {
    mockHostedClient = {};
    useNavigationStore.getState().closeSettings();
    // The route projection prefers a hosted location over the reported
    // section, so the hosted page must be set no later than the first report.
    const hostedWhenReported: boolean[] = [];
    const unsubscribe = useNavigationStore.subscribe((state, previous) => {
      if (state.settingsActiveSection !== previous.settingsActiveSection)
        hostedWhenReported.push(state.settingsHostedLocation !== null);
    });
    const tracked = trackReports();
    const harness = mount();
    act(() => {
      useNavigationStore.getState().openSettings('notifications');
    });
    await harness.render(
      <SettingsOverlay
        open
        initialSection={useNavigationStore.getState().settingsInitialSection}
        onClose={jest.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    tracked.stop();
    unsubscribe();

    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'account', page: 'notifications' },
    );
    // The local section underneath is General; it never reports Notifications.
    expect(tracked.reports).toEqual(['canopy']);
    expect(hostedWhenReported).toEqual([true]);
    harness.destroy();
    useNavigationStore.getState().closeSettings();
  });

  it('reports the local Notifications section without hosted settings', async () => {
    const harness = mount();
    await harness.render(
      <SettingsOverlay
        open
        initialSection="notifications"
        onClose={jest.fn()}
      />,
    );
    expect(reportedSection()).toBe('notifications');
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    harness.destroy();
  });
});
