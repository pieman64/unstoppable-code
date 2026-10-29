/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LABS_EXPERIMENTS } from '@canopy/desktop-shared/lib/labs-experiments';
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  createTestExperimentsBridge,
  makeTestLabsSnapshot,
  pageExperimentsOn,
  type TestExperimentsBridge,
} from '@/test-utils/labsExperiments';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  resetLabsExperimentsStoreForTest,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { DesktopLabsSettingsSection } from '../DesktopLabsSettingsSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

const AUDIT = {
  id: 'audit',
  name: 'Audit log',
  pages: ['audit' as const],
  sidebarKeys: ['audit'],
};

function installApi(bridge: TestExperimentsBridge | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: bridge ? { experiments: bridge.api } : {},
  });
}

afterEach(() => {
  resetLabsExperimentsStoreForTest();
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<DesktopLabsSettingsSection />);
    await flush();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function byTestId(container: HTMLElement, id: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `[data-testid="${id}"]`,
  );
  if (!element) throw new Error(`Expected ${id}.`);
  return element;
}

function rowIds(container: ParentNode): string[] {
  return Array.from(
    container.querySelectorAll('[data-testid^="labs-experiment-row-"]'),
  ).map((row) => row.getAttribute('data-testid') ?? '');
}

describe('DesktopLabsSettingsSection', () => {
  it('keeps Appearance save errors out of Labs', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          experiments: [
            { id: 'activity-card', requiresEarlyAccess: false, choice: true },
          ],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      act(() =>
        useLabsExperimentsStore.setState({
          errors: { sidebar: 'Could not save sidebar' },
        }),
      );
      expect(container.textContent).not.toContain('Could not save sidebar');
    } finally {
      cleanup();
    }
  });

  it('leaves the sidebar choice exclusively in Appearance', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          experiments: [
            { id: 'sidebar', requiresEarlyAccess: false, choice: true },
            { id: 'activity-card', requiresEarlyAccess: false, choice: false },
          ],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(rowIds(container)).toEqual(['labs-experiment-row-activity-card']);
    } finally {
      cleanup();
    }
  });

  it('does not treat an inherited object property as a pending switch', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          earlyAccess: true,
          experiments: [{ id: 'constructor', choice: false }],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      const toggle = byTestId(container, 'labs-experiment-toggle-constructor');
      expect(toggle.disabled).toBe(false);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });
  it('shows disabled feature rows before the snapshot is ready', async () => {
    installApi(
      createTestExperimentsBridge(makeTestLabsSnapshot({ ready: false })),
    );
    const { container, cleanup } = await mount();
    try {
      const toggle = byTestId(
        container,
        'labs-experiment-toggle-activity-card',
      );
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('lists every extracted feature independently with no master switch', async () => {
    const experiments = LABS_EXPERIMENTS.filter(
      (entry) => entry.id !== 'early-access' && entry.id !== 'sidebar',
    ).map((entry) => ({ ...entry, choice: false }));
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({ earlyAccess: false, experiments }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector('[data-testid="experimental-features-toggle"]'),
      ).toBeNull();
      for (const entry of experiments) {
        const toggle = byTestId(
          container,
          `labs-experiment-toggle-${entry.id}`,
        );
        expect(toggle.disabled).toBe(false);
        expect(toggle.getAttribute('aria-label')).toBe(entry.name);
      }
    } finally {
      cleanup();
    }
  });

  it('lists visible experiments in registry order', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          earlyAccess: true,
          experiments: [
            AUDIT,
            { id: 'gone', availability: 'hidden', choice: true },
          ],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(rowIds(container)).toEqual(['labs-experiment-row-audit']);
      expect(
        byTestId(container, 'labs-experiment-toggle-audit').getAttribute(
          'aria-checked',
        ),
      ).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('renders no section when nothing is listed', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({ earlyAccessAvailability: 'hidden' }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(
        container.querySelector(
          '[data-testid="settings-experimental-features"]',
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('shows the requested value while saving, then main’s result', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [AUDIT] }),
    );
    let resolveSave: (snapshot: LabsExperimentsSnapshot) => void = () =>
      undefined;
    bridge.respondWith(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    installApi(bridge);
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        byTestId(container, 'labs-experiment-toggle-audit').click();
        await flush();
      });
      const toggle = byTestId(container, 'labs-experiment-toggle-audit');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.disabled).toBe(true);
      expect(bridge.requests).toEqual([
        { experimentId: 'audit', enabled: true },
      ]);

      await act(async () => {
        resolveSave(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: [{ ...AUDIT, choice: true }],
            revision: 2,
          }),
        );
        await flush();
      });
      const saved = byTestId(container, 'labs-experiment-toggle-audit');
      expect(saved.getAttribute('aria-checked')).toBe('true');
      expect(saved.disabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('explains a failed save and returns the switch to main’s state', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({
        earlyAccess: false,
        experiments: [
          { id: 'activity-card', requiresEarlyAccess: false, choice: false },
        ],
      }),
    );
    bridge.respondWith(() => Promise.reject(new Error('offline')));
    installApi(bridge);
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        byTestId(container, 'labs-experiment-toggle-activity-card').click();
        await flush();
      });
      expect(
        byTestId(
          container,
          'labs-experiment-toggle-activity-card',
        ).getAttribute('aria-checked'),
      ).toBe('false');
      expect(container.textContent).toContain(
        'Could not save this setting. Try again.',
      );
    } finally {
      cleanup();
    }
  });

  it('follows a change saved from another window', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({
        experiments: [
          { id: 'activity-card', requiresEarlyAccess: false, choice: false },
        ],
      }),
    );
    installApi(bridge);
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        bridge.push(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: [
              AUDIT,
              { id: 'activity-card', requiresEarlyAccess: false, choice: true },
            ],
            revision: 2,
          }),
        );
        await flush();
      });
      expect(
        byTestId(
          container,
          'labs-experiment-toggle-activity-card',
        ).getAttribute('aria-checked'),
      ).toBe('true');
      expect(rowIds(container)).toContain('labs-experiment-row-audit');
    } finally {
      cleanup();
    }
  });

  // The registry's page experiments, not yet switched on.
  const PAGE_EXPERIMENTS = pageExperimentsOn().map((entry) => ({
    ...entry,
    choice: null,
  }));

  function sectionRowIds(container: HTMLElement, section: string): string[] {
    const element = container.querySelector(`[data-testid="${section}"]`);
    return element ? rowIds(element) : [];
  }

  it('lists page experiments in the Pages section while Early access is off', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          earlyAccess: false,
          experiments: [...PAGE_EXPERIMENTS, AUDIT],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(
        sectionRowIds(container, 'settings-experimental-features'),
      ).toEqual([]);
      expect(sectionRowIds(container, 'settings-labs-pages')).toEqual([
        'labs-experiment-row-overview-page',
        'labs-experiment-row-kanban-page',
        'labs-experiment-row-statistics-page',
        'labs-experiment-row-audit-trail-page',
      ]);
      const toggle = byTestId(container, 'labs-experiment-toggle-kanban-page');
      expect(toggle.disabled).toBe(false);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('leaves out a page experiment while its page feature flag is off', async () => {
    const WORKERS_PREVIEW = {
      id: 'workers-preview',
      name: 'Claude Workers',
      pages: ['workers' as const],
      sidebarKeys: ['workers'],
      requiresEarlyAccess: false,
    };
    const defaults = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...defaults,
        values: {
          ...defaults.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: false,
        },
      },
    });
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({
          experiments: [...PAGE_EXPERIMENTS, WORKERS_PREVIEW],
        }),
      ),
    );
    const { container, cleanup } = await mount();
    try {
      expect(sectionRowIds(container, 'settings-labs-pages')).not.toContain(
        'labs-experiment-row-workers-preview',
      );
      expect(sectionRowIds(container, 'settings-labs-pages')).toContain(
        'labs-experiment-row-kanban-page',
      );

      await act(async () => {
        useFeatureFlagsStore.setState({ snapshot: defaults });
        await flush();
      });
      expect(sectionRowIds(container, 'settings-labs-pages')).toContain(
        'labs-experiment-row-workers-preview',
      );
    } finally {
      cleanup();
    }
  });
});
