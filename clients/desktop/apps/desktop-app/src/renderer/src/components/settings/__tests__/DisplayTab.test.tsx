/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { makeTestPreferences } from '@/test-utils/preferences';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { DisplayTab } from '../DisplayTab';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'matchMedia',
);

let loadPreferences: jest.Mock;
let savePreferences: jest.Mock;

beforeEach(() => {
  loadPreferences = jest
    .fn()
    .mockResolvedValue(
      makeTestPreferences({ sidebarAppearance: 'translucent' }),
    );
  savePreferences = jest
    .fn()
    .mockResolvedValue(makeTestPreferences({ sidebarAppearance: 'opaque' }));

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadPreferences, savePreferences },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn().mockReturnValue({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }),
  });
  document.documentElement.removeAttribute('data-sidebar-appearance');
  document.documentElement.removeAttribute('data-scrollbar-behavior');
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
  if (originalMatchMediaDescriptor) {
    Object.defineProperty(window, 'matchMedia', originalMatchMediaDescriptor);
  } else {
    Reflect.deleteProperty(window, 'matchMedia');
  }
  document.documentElement.removeAttribute('data-sidebar-appearance');
  document.documentElement.removeAttribute('data-scrollbar-behavior');
});

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<DisplayTab />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe('DisplayTab sidebar appearance', () => {
  it('removes Sidebar background even with Compact sidebar off', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    const { container, cleanup } = await mount();
    try {
      expect(rowLabels(container)).not.toContain('Sidebar background');
      expect(
        container.querySelector('[data-testid^="sidebar-appearance-"]'),
      ).toBeNull();
      expect(savePreferences).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('has no sidebar row under early access', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const { container, cleanup } = await mount();

    try {
      expect(rowLabels(container)).not.toContain('Sidebar background');
      expect(
        container.querySelector('[data-testid^="sidebar-appearance-"]'),
      ).toBeNull();
    } finally {
      cleanup();
      setTestEarlyAccessFeatures({ enabled: false });
    }
  });
});

function rowLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('[data-settings-row-label]'),
  ).map((label) => label.textContent ?? '');
}

async function click(element: Element | null, name: string): Promise<void> {
  await act(async () => {
    if (!(element instanceof HTMLElement)) throw new Error(`missing ${name}`);
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DisplayTab worktree diff stats style', () => {
  it('renders after Scrollbars at the end of the Layout section', async () => {
    const { container, cleanup } = await mount();

    try {
      const labels = rowLabels(container);
      expect(labels.indexOf('Scrollbars')).toBeLessThan(
        labels.indexOf('Worktree diff stats'),
      );
      // The row sits in a group whose hairline splits it from the row above.
      const row = container.querySelector(
        '[data-testid="worktree-diff-stats-section"]',
      );
      expect(row?.previousElementSibling).not.toBeNull();
      expect(row?.nextElementSibling).toBeNull();
      expect(row?.parentElement?.classList.contains('divide-y')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('defaults to Short and persists the Complete choice', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ worktreeDiffStatsStyle: 'short' }),
    );
    savePreferences.mockResolvedValue(
      makeTestPreferences({ worktreeDiffStatsStyle: 'complete' }),
    );
    const { container, cleanup } = await mount();

    try {
      const short = container.querySelector(
        '[data-testid="worktree-diff-stats-style-short"]',
      );
      const complete = container.querySelector(
        '[data-testid="worktree-diff-stats-style-complete"]',
      );

      expect(short?.getAttribute('aria-pressed')).toBe('true');
      expect(complete?.getAttribute('aria-pressed')).toBe('false');

      await click(complete, 'Complete');

      expect(savePreferences).toHaveBeenCalledWith({
        worktreeDiffStatsStyle: 'complete',
      });
      expect(complete?.getAttribute('aria-pressed')).toBe('true');
      // One raised surface, the secondary button's, slides under the chosen
      // segment; the segments themselves only change ink. Neither relies on
      // an inert border color.
      const surface = complete
        ?.closest('[role="group"]')
        ?.querySelector(':scope > span[aria-hidden="true"]');
      expect(surface?.classList.contains('bg-quaternary')).toBe(true);
      expect(surface?.classList.contains('shadow-sm')).toBe(true);
      expect(complete?.classList.contains('fg-primary')).toBe(true);
      expect(short?.classList.contains('bg-quaternary')).toBe(false);
      expect(short?.classList.contains('fg-secondary')).toBe(true);
      expect(
        Array.from(complete?.classList ?? []).some((name) =>
          name.startsWith('border-'),
        ),
      ).toBe(false);
      expect(
        container.querySelector('[data-testid="worktree-diff-stats-section"]')
          ?.textContent,
      ).toContain('Show every digit');
    } finally {
      cleanup();
    }
  });
});

describe('DisplayTab sidebar items (CAN-3678)', () => {
  it('closes Settings and asks the sidebar to open Customize', async () => {
    useNavigationStore.setState({
      settingsOpen: true,
      customizeSidebarRequested: false,
    });
    const { container, cleanup } = await mount();
    try {
      const labels = rowLabels(container);
      expect(labels.indexOf('Sidebar items')).toBeGreaterThan(
        labels.indexOf('Sidebar style'),
      );
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-customize-sidebar"]',
      );
      expect(button?.textContent).toBe('Customize…');
      act(() => button?.click());
      const state = useNavigationStore.getState();
      expect(state.settingsOpen).toBe(false);
      expect(state.customizeSidebarRequested).toBe(true);
    } finally {
      cleanup();
      useNavigationStore.setState({ customizeSidebarRequested: false });
    }
  });
});

describe('DisplayTab project layout default', () => {
  it('renders the project layout row after Sidebar', async () => {
    const { container, cleanup } = await mount();
    try {
      const labels = rowLabels(container);
      expect(labels.indexOf('Sidebar style')).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('Sidebar style')).toBeLessThan(
        labels.indexOf('Project layout'),
      );
    } finally {
      cleanup();
    }
  });

  it('persists accessible Minimal and Advanced choices immediately', async () => {
    const { container, cleanup } = await mount();
    try {
      const minimal = container.querySelector(
        '[data-testid="workspace-layout-default-minimal"]',
      );
      const advanced = container.querySelector(
        '[data-testid="workspace-layout-default-advanced"]',
      );
      expect(minimal?.textContent).toBe('Minimal');
      expect(advanced?.getAttribute('aria-pressed')).toBe('true');
      expect(advanced?.classList.contains('fg-primary')).toBe(true);
      await click(minimal, 'Minimal');
      expect(savePreferences).toHaveBeenCalledWith({
        workspaceDefaultLayoutMode: 'minimal',
      });
      expect(minimal?.getAttribute('aria-pressed')).toBe('true');
      // The row explains the chosen layout.
      expect(container.textContent).toContain(
        'fixed chat, side panel, and bottom drawer areas',
      );
      expect(container.textContent).not.toContain('Extras');
    } finally {
      cleanup();
    }
  });

  it('restores the previous choice and reports a save failure', async () => {
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const { container, cleanup } = await mount();
    try {
      const minimal = container.querySelector(
        '[data-testid="workspace-layout-default-minimal"]',
      );
      await click(minimal, 'Minimal');
      expect(minimal?.getAttribute('aria-pressed')).toBe('false');
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't save project layout setting.",
      );
      expect(
        container
          .querySelector('[role="alert"]')
          ?.classList.contains('fg-destructive'),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('DisplayTab project layout under early access', () => {
  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
  });

  it('still sets only the default for new worktrees', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const { container, cleanup } = await mount();
    try {
      await click(
        container.querySelector(
          '[data-testid="workspace-layout-default-minimal"]',
        ),
        'Minimal',
      );
      // Early access never turns this row into a switch for every worktree.
      expect(savePreferences).toHaveBeenCalledWith({
        workspaceDefaultLayoutMode: 'minimal',
      });
      expect(container.textContent).toContain(
        'Used for new worktrees and work entries.',
      );
    } finally {
      cleanup();
    }
  });
});

function scrollbarSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector(
    '[data-testid="settings-scrollbar-behavior"]',
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Expected the scrollbar behavior select');
  }
  return select;
}

describe('DisplayTab scrollbar behavior', () => {
  it('defaults to System and persists an explicit behavior immediately', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ scrollbarBehavior: 'system' }),
    );
    const { container, cleanup } = await mount();

    try {
      const select = scrollbarSelect(container);
      expect(select.value).toBe('system');
      expect(
        container.querySelector('[data-testid="scrollbar-behavior-row"]')
          ?.textContent,
      ).toContain('Derived from your system settings');
      expect(document.documentElement.dataset.scrollbarBehavior).toBe('system');

      await act(async () => {
        select.value = 'hover';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });

      expect(savePreferences).toHaveBeenCalledWith({
        scrollbarBehavior: 'hover',
      });
      expect(document.documentElement.dataset.scrollbarBehavior).toBe('hover');
      expect(
        container.querySelector('[data-testid="scrollbar-behavior-row"]')
          ?.textContent,
      ).toContain('Show while hovering over a scrollable area');
    } finally {
      cleanup();
    }
  });

  it('offers every supported explicit behavior', async () => {
    const { container, cleanup } = await mount();

    try {
      expect(
        Array.from(scrollbarSelect(container).options).map(
          (option) => option.value,
        ),
      ).toEqual(['system', 'always', 'scroll', 'hover', 'never']);
    } finally {
      cleanup();
    }
  });
});

describe('DisplayTab interface scale', () => {
  it('offers the whole supported range', async () => {
    const { container, cleanup } = await mount();

    try {
      const select = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-ui-scale-select"]',
      );
      act(() => select?.click());
      const options = document.querySelectorAll(
        '[data-testid^="settings-ui-scale-option-"]',
      );
      expect(options).toHaveLength(31);
      expect(options[0]?.textContent).toBe('50%');
      expect(options[30]?.textContent).toBe('200%');
    } finally {
      cleanup();
    }
  });

  it('follows a scale saved elsewhere, such as the View-menu zoom items', async () => {
    const listeners: ((preferences: unknown) => void)[] = [];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences,
        savePreferences,
        onPreferencesSynced: (listener: (preferences: unknown) => void) => {
          listeners.push(listener);
          return (): void => {};
        },
      },
    });
    const { container, cleanup } = await mount();

    try {
      const select = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-ui-scale-select"]',
      );
      expect(select?.textContent).toContain('100%');
      await act(async () => {
        for (const listener of listeners) {
          listener(makeTestPreferences({ uiScale: 125 }));
        }
        await Promise.resolve();
      });
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="settings-ui-scale-select"]',
        )?.textContent,
      ).toContain('125%');
    } finally {
      cleanup();
    }
  });

  it('ignores echoes of its own in-flight writes while choices are saved', async () => {
    const listeners: ((preferences: unknown) => void)[] = [];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences,
        savePreferences,
        onPreferencesSynced: (listener: (preferences: unknown) => void) => {
          listeners.push(listener);
          return (): void => {};
        },
      },
    });
    const { container, cleanup } = await mount();

    const selectedScale = (): string | null | undefined =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-ui-scale-select"]',
      )?.textContent;
    const broadcast = async (uiScale: number): Promise<void> => {
      await act(async () => {
        for (const listener of listeners) {
          listener(makeTestPreferences({ uiScale }));
        }
        await Promise.resolve();
      });
    };
    const choose = async (uiScale: number): Promise<void> => {
      const select = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-ui-scale-select"]',
      );
      if (!select) throw new Error('ui scale dropdown not found');
      act(() => select.click());
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="settings-ui-scale-option-${uiScale}"]`,
          )
          ?.click();
        await Promise.resolve();
      });
    };

    try {
      // Rapid selections outrun the serialized saves: main is still committing 105
      // while the dropdown has already reached 130.
      await choose(105);
      await choose(130);
      expect(selectedScale()).toContain('130%');

      // The stale echo of the first save must not replace the current selection.
      await broadcast(105);
      expect(selectedScale()).toContain('130%');

      // The echo that catches up neither changes the selection nor stays latched...
      await broadcast(130);
      expect(selectedScale()).toContain('130%');

      // ...so a genuine external change (a View-menu zoom step) still lands.
      await broadcast(150);
      expect(selectedScale()).toContain('150%');
    } finally {
      cleanup();
    }
  });
});

function enrichmentSelect(
  container: HTMLElement,
  provider: 'linear' | 'github',
): HTMLSelectElement {
  const select = container.querySelector(
    `[data-testid="settings-${provider}-chat-enrichment-mode"]`,
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Expected the ${provider} chat enrichment select`);
  }
  return select;
}

async function chooseEnrichmentMode(
  container: HTMLElement,
  provider: 'linear' | 'github',
  mode: string,
): Promise<void> {
  await act(async () => {
    const select = enrichmentSelect(container, provider);
    select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function captureSyncedListeners(): ((preferences: unknown) => void)[] {
  const listeners: ((preferences: unknown) => void)[] = [];
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences,
      onPreferencesSynced: (listener: (preferences: unknown) => void) => {
        listeners.push(listener);
        return (): void => {};
      },
    },
  });
  return listeners;
}

describe('DisplayTab chat area data enrichment', () => {
  it('defaults to Linear Replace and GitHub Hover with labeled selects and explanations', async () => {
    const { container, cleanup } = await mount();

    try {
      const linear = enrichmentSelect(container, 'linear');
      const github = enrichmentSelect(container, 'github');
      expect(linear.value).toBe('replace');
      expect(github.value).toBe('hover');
      for (const select of [linear, github]) {
        expect(
          Array.from(select.options, (option) => [
            option.value,
            option.textContent,
          ]),
        ).toEqual([
          ['replace', 'Replace'],
          ['hover', 'Hover'],
          ['off', 'Off'],
        ]);
      }
      expect(
        container.querySelector(`label[for="${linear.id}"]`)?.textContent,
      ).toBe('Linear');
      expect(
        container.querySelector(`label[for="${github.id}"]`)?.textContent,
      ).toBe('GitHub');
      expect(linear.getAttribute('aria-label')).toBe('Linear chat enrichment');
      expect(github.getAttribute('aria-label')).toBe('GitHub chat enrichment');
      const labels = rowLabels(container);
      expect(labels.slice(-3)).toEqual(['Linear', 'GitHub', 'How it works']);
      const explanation = container.querySelector(
        '[data-testid="chat-enrichment-how-it-works"]',
      )?.textContent;
      expect(explanation).toContain(
        'Show titles and icons in chat, with previews on hover or focus.',
      );
      expect(explanation).toContain(
        'Keep the original text and add links with previews on hover or focus.',
      );
      expect(explanation).toContain(
        'Keep the original text and links without enrichment.',
      );
    } finally {
      cleanup();
    }
  });

  it('shows saved modes for each provider', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({
        linearChatEnrichmentMode: 'off',
        githubChatEnrichmentMode: 'replace',
      }),
    );
    const { container, cleanup } = await mount();

    try {
      expect(enrichmentSelect(container, 'linear').value).toBe('off');
      expect(enrichmentSelect(container, 'github').value).toBe('replace');
    } finally {
      cleanup();
    }
  });

  it('saves only the changed provider and shares the saved preferences', async () => {
    const saved = makeTestPreferences({
      linearChatEnrichmentMode: 'off',
      githubChatEnrichmentMode: 'hover',
    });
    savePreferences.mockResolvedValue(saved);
    const shared = jest.fn<void, [PreferencesData]>();
    const unsubscribe = subscribePreferencesUpdated(shared);
    const { container, cleanup } = await mount();

    try {
      await chooseEnrichmentMode(container, 'linear', 'off');

      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(savePreferences).toHaveBeenCalledWith({
        linearChatEnrichmentMode: 'off',
      });
      expect(shared).toHaveBeenCalledTimes(1);
      expect(shared).toHaveBeenCalledWith(saved);
      expect(enrichmentSelect(container, 'linear').value).toBe('off');
      expect(enrichmentSelect(container, 'github').value).toBe('hover');
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      unsubscribe();
      cleanup();
    }
  });

  it('restores the previous mode and reports a failed save', async () => {
    const listeners = captureSyncedListeners();
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const shared = jest.fn<void, [PreferencesData]>();
    const unsubscribe = subscribePreferencesUpdated(shared);
    const { container, cleanup } = await mount();

    try {
      await chooseEnrichmentMode(container, 'github', 'off');

      expect(enrichmentSelect(container, 'github').value).toBe('hover');
      expect(enrichmentSelect(container, 'linear').value).toBe('replace');
      expect(shared).not.toHaveBeenCalled();
      const alert = container.querySelector(
        '[data-testid="github-chat-enrichment-row"] [role="alert"]',
      );
      expect(alert?.textContent).toBe(
        'Could not save this setting. Try again.',
      );
      expect(alert?.classList.contains('fg-destructive')).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="linear-chat-enrichment-row"] [role="alert"]',
        ),
      ).toBeNull();

      // An unrelated broadcast does not hide the failure.
      await act(async () => {
        for (const listener of listeners) {
          listener(makeTestPreferences({ uiScale: 110 }));
        }
        await Promise.resolve();
      });
      expect(
        container.querySelector(
          '[data-testid="github-chat-enrichment-row"] [role="alert"]',
        )?.textContent,
      ).toBe('Could not save this setting. Try again.');
      expect(enrichmentSelect(container, 'github').value).toBe('hover');

      // A successful retry clears it.
      await chooseEnrichmentMode(container, 'github', 'off');
      expect(
        container.querySelector(
          '[data-testid="github-chat-enrichment-row"] [role="alert"]',
        ),
      ).toBeNull();
    } finally {
      unsubscribe();
      cleanup();
    }
  });

  it('follows modes saved in another window', async () => {
    const listeners = captureSyncedListeners();
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        for (const listener of listeners) {
          listener(
            makeTestPreferences({
              linearChatEnrichmentMode: 'hover',
              githubChatEnrichmentMode: 'off',
            }),
          );
        }
        await Promise.resolve();
      });

      expect(enrichmentSelect(container, 'linear').value).toBe('hover');
      expect(enrichmentSelect(container, 'github').value).toBe('off');
    } finally {
      cleanup();
    }
  });

  it('keeps a pending choice through stale broadcasts, then shows the saved mode', async () => {
    const listeners = captureSyncedListeners();
    let resolveSave: (preferences: unknown) => void = () => {};
    savePreferences.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { container, cleanup } = await mount();
    const broadcast = async (
      linearChatEnrichmentMode: 'replace' | 'hover' | 'off',
    ): Promise<void> => {
      await act(async () => {
        for (const listener of listeners) {
          listener(
            makeTestPreferences({
              linearChatEnrichmentMode,
              githubChatEnrichmentMode: 'replace',
            }),
          );
        }
        await Promise.resolve();
      });
    };

    try {
      await chooseEnrichmentMode(container, 'linear', 'off');
      await broadcast('replace');

      expect(enrichmentSelect(container, 'linear').value).toBe('off');
      // Another provider's change still lands while Linear is saving.
      expect(enrichmentSelect(container, 'github').value).toBe('replace');

      await act(async () => {
        resolveSave(
          makeTestPreferences({
            linearChatEnrichmentMode: 'off',
            githubChatEnrichmentMode: 'replace',
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(enrichmentSelect(container, 'linear').value).toBe('off');

      await broadcast('hover');
      expect(enrichmentSelect(container, 'linear').value).toBe('hover');
    } finally {
      cleanup();
    }
  });

  function deferInitialLoad(): (preferences: PreferencesData) => Promise<void> {
    let resolveLoad: (preferences: PreferencesData) => void = () => {};
    const load = new Promise<PreferencesData>((resolve) => {
      resolveLoad = resolve;
    });
    loadPreferences.mockReturnValue(load);
    return async (preferences) => {
      await act(async () => {
        resolveLoad(preferences);
        await Promise.resolve();
        await Promise.resolve();
      });
    };
  }

  const staleLoad = makeTestPreferences({
    linearChatEnrichmentMode: 'replace',
    githubChatEnrichmentMode: 'replace',
  });

  it('ignores an initial load that answers after a newer broadcast', async () => {
    const resolveLoad = deferInitialLoad();
    const listeners = captureSyncedListeners();
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        for (const listener of listeners) {
          listener(
            makeTestPreferences({
              linearChatEnrichmentMode: 'off',
              githubChatEnrichmentMode: 'off',
            }),
          );
        }
        await Promise.resolve();
      });
      await resolveLoad(staleLoad);

      expect(enrichmentSelect(container, 'linear').value).toBe('off');
      expect(enrichmentSelect(container, 'github').value).toBe('off');
    } finally {
      cleanup();
    }
  });

  it('ignores an initial load that answers after a newer save', async () => {
    const resolveLoad = deferInitialLoad();
    savePreferences.mockResolvedValue(
      makeTestPreferences({
        linearChatEnrichmentMode: 'off',
        githubChatEnrichmentMode: 'off',
      }),
    );
    const { container, cleanup } = await mount();

    try {
      await chooseEnrichmentMode(container, 'linear', 'off');
      await resolveLoad(staleLoad);

      expect(enrichmentSelect(container, 'linear').value).toBe('off');
      expect(enrichmentSelect(container, 'github').value).toBe('off');

      // A later failed save restores the saved mode, not the stale load.
      savePreferences.mockRejectedValueOnce(new Error('disk full'));
      await chooseEnrichmentMode(container, 'linear', 'hover');
      expect(enrichmentSelect(container, 'linear').value).toBe('off');
    } finally {
      cleanup();
    }
  });

  it('handles a failed initial load and keeps the defaults', async () => {
    const loadError = new Error('preferences unavailable');
    const unhandled = jest.fn();
    const onUnhandled = (reason: unknown): void => {
      if (reason === loadError) unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // The section mounts its effect before the page's own initial load.
    loadPreferences.mockRejectedValueOnce(loadError);
    const { container, cleanup } = await mount();

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
      expect(enrichmentSelect(container, 'linear').value).toBe('replace');
      expect(enrichmentSelect(container, 'github').value).toBe('hover');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      cleanup();
    }
  });
});

describe('DisplayTab headings', () => {
  it('renders the page and section headings', async () => {
    const { container, cleanup } = await mount();
    try {
      expect(container.querySelector('h1')?.textContent).toBe('Display');
      expect(
        Array.from(
          container.querySelectorAll('h2'),
          (heading) => heading.textContent,
        ),
      ).toEqual(['Appearance', 'Layout', 'Chat area data enrichment']);
    } finally {
      cleanup();
    }
  });
});
