/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsOverlay } from '../SettingsOverlay';
import {
  defaultRemoteControlState,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import type { RemoteControlContext } from '@canopy/desktop-shared/types';

jest.mock('../CanopyTab', () => ({
  CanopyTab: (): JSX.Element => <div data-testid="canopy-tab" />,
}));
jest.mock('../CodeGraphTab', () => ({
  CodeGraphTab: (): JSX.Element => <div data-testid="code-graph-tab" />,
}));
jest.mock('../ExperimentsTab', () => ({
  ExperimentsTab: (): JSX.Element => <div data-testid="experiments-tab" />,
}));
jest.mock('../PerformanceTab', () => ({ PerformanceTab: (): null => null }));
jest.mock('../KeyboardShortcutsTab', () => ({
  KeyboardShortcutsTab: (): null => null,
}));
jest.mock('../DisplayTab', () => ({ DisplayTab: (): null => null }));
jest.mock('../NotificationsTab', () => ({
  NotificationsTab: (): null => null,
}));
jest.mock('../AccountTab', () => ({ AccountTab: (): null => null }));
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
jest.mock('../GitTab', () => ({
  GitTab: (): JSX.Element => <div data-testid="git-tab" />,
}));
jest.mock('../ApplicationsTab', () => ({ ApplicationsTab: (): null => null }));
jest.mock('../EnvironmentsTab', () => ({
  EnvironmentsTab: (): JSX.Element => (
    <div data-testid="settings-tab-environment" />
  ),
}));
jest.mock('../McpTab', () => ({ McpTab: (): null => null }));
jest.mock('../RemoteAccessTab', () => ({
  RemoteAccessTab: (): JSX.Element => <div data-testid="remote-access-tab" />,
}));
jest.mock('../LegalTab', () => ({
  LegalTab: (): JSX.Element => <div data-testid="legal-tab" />,
}));
let codeGraphExperimentEnabled = true;
jest.mock('@/hooks/useCodeGraphExperimentEnabled', () => ({
  useCodeGraphExperimentEnabled: (): boolean => codeGraphExperimentEnabled,
}));
jest.mock('@/lib/claude-settings-availability', () => ({
  useClaudeSettingsAvailable: (): boolean => true,
}));

let mockCursorHarnessEnabled = true;
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    selector: (state: { isEnabled: () => boolean }) => boolean,
  ): boolean => selector({ isEnabled: () => mockCursorHarnessEnabled }),
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

describe('SettingsOverlay navigation', () => {
  beforeEach(() => {
    mockCursorHarnessEnabled = true;
    codeGraphExperimentEnabled = true;
  });

  it('switches sections when initialSection changes while mounted', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <SettingsOverlay initialSection="canopy" onClose={jest.fn()} />,
      );
    });
    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="experiments" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="experiments-tab"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="canopy-tab"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('renders Settings → Environments for the environment section', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = jest.fn();

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="environment" onClose={onClose} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      isDisplayed(
        container.querySelector('[data-testid="settings-tab-environment"]'),
      ),
    ).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it('keeps the current page on screen while the next page loads', async () => {
    // Legal is rendered by no other test in this file, so its lazy page
    // module is still unloaded when the nav row is clicked.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="canopy" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="settings-nav-legal"]')
        ?.click();
    });
    // The Legal page's code has not arrived yet. General stays on screen
    // instead of the blank Suspense fallback. A fallback would keep General
    // mounted but hidden, so check that it is still displayed.
    expect(
      isDisplayed(container.querySelector('[data-testid="canopy-tab"]')),
    ).toBe(true);
    expect(container.querySelector('[data-testid="legal-tab"]')).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="legal-tab"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canopy-tab"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('opens each page at its top', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SettingsOverlay initialSection="git" onClose={jest.fn()} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="git-tab"]')).not.toBeNull();
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="settings-content"] > .overflow-auto',
    );
    if (!scrollContainer) {
      throw new Error('settings scroll container not found');
    }
    scrollContainer.scrollTop = 500;

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="settings-nav-canopy"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();
    expect(scrollContainer.scrollTop).toBe(0);

    act(() => root.unmount());
    container.remove();
  });

  it('preserves an unrelated active section when feature visibility changes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SettingsOverlay initialSection="git" onClose={jest.fn()} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="git-tab"]')).not.toBeNull();

    codeGraphExperimentEnabled = false;
    act(() => {
      root.render(<SettingsOverlay initialSection="git" onClose={jest.fn()} />);
    });
    expect(container.querySelector('[data-testid="git-tab"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canopy-tab"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('keeps Experiments available when Code Graph is off', async () => {
    codeGraphExperimentEnabled = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="experiments" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="experiments-tab"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('opens the Code Graph section from the Advanced group', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="code-graph" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="code-graph-tab"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="settings-nav-group-advanced"] [data-testid="settings-nav-code-graph"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="experiments-tab"]'),
    ).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('falls back to General when Code Graph is unavailable', async () => {
    codeGraphExperimentEnabled = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="code-graph" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="code-graph-tab"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="settings-nav-code-graph"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('returns to the default section when reopened without an explicit section', async () => {
    jest.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsOverlay open initialSection="git" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="git-tab"]')).not.toBeNull();

    act(() => {
      root.render(<SettingsOverlay open={false} onClose={jest.fn()} />);
    });
    await act(async () => {
      root.render(<SettingsOverlay open onClose={jest.fn()} />);
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="git-tab"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });
});

it('keeps Experiments reachable when every flagged experiment is off', async () => {
  // Managed delegation and faster window opening are plain preferences
  // rather than flagged capabilities, so the tab always has something to
  // show and its deep link always resolves to itself.
  codeGraphExperimentEnabled = false;
  mockCursorHarnessEnabled = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="experiments" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="settings-nav-experiments"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="experiments-tab"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="canopy-tab"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SettingsOverlay remote access section', () => {
  afterEach(() => {
    useRemoteControlStore.setState({
      hydrated: false,
      context: { mode: 'local' },
      state: defaultRemoteControlState(),
    });
  });

  function seed(available: boolean, context: RemoteControlContext): void {
    useRemoteControlStore.setState({
      hydrated: true,
      context,
      state: { ...defaultRemoteControlState(), available, signedIn: true },
    });
  }

  async function renderAt(): Promise<{
    container: HTMLElement;
    unmount: () => void;
  }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsOverlay initialSection="remote-access" onClose={jest.fn()} />,
      );
      await Promise.resolve();
    });
    return {
      container,
      unmount: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it('opens Remote access from the Personal group when it is available', async () => {
    seed(true, { mode: 'local' });
    const { container, unmount } = await renderAt();
    expect(
      container.querySelector('[data-testid="remote-access-tab"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="settings-nav-group-personal"] [data-testid="settings-nav-remote-access"]',
      ),
    ).not.toBeNull();
    unmount();
  });

  it('falls back to General when the feature is off', async () => {
    seed(false, { mode: 'local' });
    const { container, unmount } = await renderAt();
    expect(
      container.querySelector('[data-testid="remote-access-tab"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="settings-nav-remote-access"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="canopy-tab"]'),
    ).not.toBeNull();
    unmount();
  });

  it('leaves the section out of a window that shows another computer', async () => {
    seed(true, {
      mode: 'remote',
      deviceId: 'dev-studio',
      name: 'Studio desktop',
      platform: 'linux',
    });
    const { container, unmount } = await renderAt();
    expect(
      container.querySelector('[data-testid="settings-nav-remote-access"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="remote-access-tab"]'),
    ).toBeNull();
    unmount();
  });
});
