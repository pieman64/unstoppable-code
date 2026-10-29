/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { SETTINGS_SECTION_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import type * as ReplaySurfaces from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { SettingsOverlay } from '../SettingsOverlay';
import type * as SettingsLayoutModule from '../SettingsLayout';

// Five sections render the real `SettingsPage`, so the test reads the class
// the page kit applies: two reviewed (Display, Legal) and three blocked
// (General, Git, Accounts). Legal and Accounts are rendered by no other test
// in this file before their lazy-load test, so their page modules are still
// unloaded there.
function mockRealPage(title: string, testId: string): () => JSX.Element {
  return function Page(): JSX.Element {
    const { SettingsPage } =
      jest.requireActual<typeof SettingsLayoutModule>('../SettingsLayout');
    return (
      <SettingsPage title={title} dataTestId={testId}>
        <p>{title} body</p>
      </SettingsPage>
    );
  };
}

// No section is classified `blocked` today. A fixture classification keeps
// the blocked path (and its loading handoff) covered.
jest.mock(
  '@canopy/desktop-instrumentation/posthog-replay-surfaces',
  (): typeof ReplaySurfaces => {
    const actual: typeof ReplaySurfaces = jest.requireActual(
      '@canopy/desktop-instrumentation/posthog-replay-surfaces',
    );
    return {
      ...actual,
      SETTINGS_SECTION_REPLAY_PRIVACY: Object.freeze({
        ...actual.SETTINGS_SECTION_REPLAY_PRIVACY,
        git: 'blocked',
        account: 'blocked',
      }),
    };
  },
);
jest.mock('../CanopyTab', () => ({
  CanopyTab: mockRealPage('General', 'canopy-tab'),
}));
jest.mock('../GitTab', () => ({ GitTab: mockRealPage('Git', 'git-tab') }));
jest.mock('../AccountTab', () => ({
  AccountTab: mockRealPage('Accounts', 'account-tab'),
}));
jest.mock('../LegalTab', () => ({
  LegalTab: mockRealPage('Legal', 'legal-tab'),
}));
jest.mock('../CodeGraphTab', () => ({ CodeGraphTab: (): null => null }));
jest.mock('../ExperimentsTab', () => ({ ExperimentsTab: (): null => null }));
jest.mock('../PerformanceTab', () => ({ PerformanceTab: (): null => null }));
jest.mock('../KeyboardShortcutsTab', () => ({
  KeyboardShortcutsTab: (): null => null,
}));
jest.mock('../DisplayTab', () => ({
  DisplayTab: mockRealPage('Display', 'display-tab'),
}));
jest.mock('../NotificationsTab', () => ({
  NotificationsTab: (): null => null,
}));
jest.mock('../PrivacyTab', () => ({ PrivacyTab: (): null => null }));
jest.mock('../ChatTab', () => ({ ChatTab: (): null => null }));
jest.mock('../AppAdvisorTab', () => ({ AppAdvisorTab: (): null => null }));
jest.mock('../FilesTab', () => ({ FilesTab: (): null => null }));
jest.mock('../PlanDetectionTab', () => ({
  PlanDetectionTab: (): null => null,
}));
jest.mock('../DictationTab', () => ({ DictationTab: (): null => null }));
jest.mock('../CodexTab', () => ({ CodexTab: (): null => null }));
jest.mock('../ClaudeTab', () => ({ ClaudeTab: (): null => null }));
jest.mock('../OllamaTab', () => ({ OllamaTab: (): null => null }));
jest.mock('../ApplicationsTab', () => ({ ApplicationsTab: (): null => null }));
jest.mock('../McpTab', () => ({ McpTab: (): null => null }));
jest.mock('@/hooks/useCodeGraphExperimentEnabled', () => ({
  useCodeGraphExperimentEnabled: (): boolean => false,
}));
jest.mock('@/lib/claude-settings-availability', () => ({
  useClaudeSettingsAvailable: (): boolean => true,
}));
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    selector: (state: { isEnabled: () => boolean }) => boolean,
  ): boolean => selector({ isEnabled: () => false }),
}));

/** False when the element is missing or React's Suspense hid it. */
function isDisplayed(element: Element | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') {
      return false;
    }
  }
  return element !== null;
}

describe('SettingsOverlay session-replay classification (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function page(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  /**
   * A section's classification lands on its page content; the page root and
   * its header (the title) stay recorded either way.
   */
  function isBlocked(testId: string): boolean {
    const root = page(testId);
    expect(root?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      root
        ?.querySelector(':scope > header')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? null,
    ).toBeNull();
    return (
      root
        ?.querySelector(':scope > div')
        ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS) ?? false
    );
  }

  async function open(section: 'canopy' | 'display' | 'git'): Promise<void> {
    await act(async () => {
      root.render(
        <SettingsOverlay initialSection={section} onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('blocks a blocked section and records a reviewed one', async () => {
    expect(SETTINGS_SECTION_REPLAY_PRIVACY.git).toBe('blocked');
    expect(SETTINGS_SECTION_REPLAY_PRIVACY.display).toBe('reviewed');

    await open('git');
    await settle();
    expect(page('git-tab')).not.toBeNull();
    expect(isBlocked('git-tab')).toBe(true);

    await open('display');
    await settle();
    expect(page('display-tab')).not.toBeNull();
    expect(isBlocked('display-tab')).toBe(false);
  });

  it('records a reviewed section header and content, not just its root', async () => {
    // A reviewed section's static copy is recorded; its components block or
    // mask their own dynamic content.
    expect(SETTINGS_SECTION_REPLAY_PRIVACY.canopy).toBe('reviewed');
    await open('canopy');
    await settle();
    const root = page('canopy-tab');
    expect(root).not.toBeNull();
    expect(isBlocked('canopy-tab')).toBe(false);
    const header = root?.querySelector(':scope > header');
    const content = root?.querySelector(':scope > div');
    expect(header).not.toBeNull();
    expect(content).not.toBeNull();
    expect(header?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(content?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(root?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('keeps the displayed reviewed page recorded while a blocked page loads', async () => {
    expect(SETTINGS_SECTION_REPLAY_PRIVACY.account).toBe('blocked');
    await open('display');
    await settle();
    expect(isBlocked('display-tab')).toBe(false);

    act(() => {
      page('settings-nav-account')?.click();
    });
    // Accounts is still loading, so Display stays on screen. The class
    // follows the section on screen, not the one just selected.
    expect(isDisplayed(page('display-tab'))).toBe(true);
    expect(page('account-tab')).toBeNull();
    expect(isBlocked('display-tab')).toBe(false);

    await settle();
    expect(page('display-tab')).toBeNull();
    expect(isBlocked('account-tab')).toBe(true);
  });

  it('keeps the displayed blocked page blocked while a reviewed page loads', async () => {
    expect(SETTINGS_SECTION_REPLAY_PRIVACY.legal).toBe('reviewed');
    await open('git');
    await settle();
    expect(isBlocked('git-tab')).toBe(true);

    act(() => {
      page('settings-nav-legal')?.click();
    });
    expect(isDisplayed(page('git-tab'))).toBe(true);
    expect(page('legal-tab')).toBeNull();
    expect(isBlocked('git-tab')).toBe(true);

    await settle();
    expect(page('git-tab')).toBeNull();
    expect(page('legal-tab')).not.toBeNull();
    expect(isBlocked('legal-tab')).toBe(false);
  });
});
