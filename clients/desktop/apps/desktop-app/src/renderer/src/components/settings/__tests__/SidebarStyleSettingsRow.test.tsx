/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import {
  createTestExperimentsBridge,
  makeTestLabsSnapshot,
  type TestExperimentsBridge,
} from '@/test-utils/labsExperiments';
import { resetLabsExperimentsStoreForTest } from '@/stores/labsExperimentsStore';
import { SidebarStyleSettingsRow } from '../SidebarStyleSettingsRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
const sidebar = { id: 'sidebar', requiresEarlyAccess: false };
function snapshot(compact: boolean, revision = 1): LabsExperimentsSnapshot {
  return makeTestLabsSnapshot({
    earlyAccess: false,
    revision,
    experiments: [{ ...sidebar, choice: compact }],
  });
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
async function mount(
  bridge: TestExperimentsBridge,
): Promise<{ container: HTMLDivElement; cleanup: () => void }> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { experiments: bridge.api },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SidebarStyleSettingsRow />);
    await flush();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
function trigger(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-style-picker"]',
  );
  if (!element) throw new Error('Missing sidebar dropdown');
  return element;
}
function expectStyle(container: HTMLElement, compact: boolean): void {
  expect(trigger(container).textContent).toContain(
    compact ? 'Compact' : 'Advanced',
  );
}
async function choose(container: HTMLElement, style: string): Promise<void> {
  act(() => trigger(container).click());
  await act(async () => {
    const option = document.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar-style-${style}"]`,
    );
    if (!option) throw new Error(`Missing ${style} option`);
    option.click();
    await flush();
  });
}
afterEach(() => {
  resetLabsExperimentsStoreForTest();
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});
it.each([false, true])(
  'preserves an existing sidebar choice (%s) independently of Early access',
  async (compact) => {
    const { container, cleanup } = await mount(
      createTestExperimentsBridge(snapshot(compact)),
    );
    try {
      expectStyle(container, compact);
      act(() => trigger(container).click());
      expect(
        document
          .querySelector('[data-testid="sidebar-style-compact"]')
          ?.getAttribute('aria-selected'),
      ).toBe(String(compact));
      expect(
        document
          .querySelector('[data-testid="sidebar-style-advanced"]')
          ?.getAttribute('aria-selected'),
      ).toBe(String(!compact));
      expect(
        document.querySelector(
          '[data-testid="sidebar-style-advanced"] [data-testid="sidebar-style-preview-advanced"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="sidebar-style-compact"] [data-testid="sidebar-style-preview-compact"]',
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  },
);
it('saves only the sidebar choice, shows pending selection and follows main’s committed result', async () => {
  const bridge = createTestExperimentsBridge(snapshot(false));
  let settle: (value: LabsExperimentsSnapshot) => void = () => undefined;
  bridge.respondWith(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const { container, cleanup } = await mount(bridge);
  try {
    await choose(container, 'compact');
    expect(bridge.requests).toEqual([
      { experimentId: 'sidebar', enabled: true },
    ]);
    expectStyle(container, true);
    expect(trigger(container).disabled).toBe(true);
    await act(async () => {
      settle(snapshot(true, 2));
      await flush();
    });
    expectStyle(container, true);
    expect(trigger(container).disabled).toBe(false);
  } finally {
    cleanup();
  }
});
it('restores the saved style and displays a failed save beside its options', async () => {
  const bridge = createTestExperimentsBridge(snapshot(true));
  bridge.respondWith(() => Promise.reject(new Error('offline')));
  const { container, cleanup } = await mount(bridge);
  try {
    await choose(container, 'advanced');
    expectStyle(container, true);
    expect(trigger(container).disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not save this setting. Try again.',
    );
  } finally {
    cleanup();
  }
});
it('follows another window and account changes', async () => {
  const bridge = createTestExperimentsBridge(snapshot(true));
  const { container, cleanup } = await mount(bridge);
  try {
    await act(async () => {
      bridge.push(snapshot(false, 2));
      await flush();
    });
    expectStyle(container, false);
    await act(async () => {
      bridge.push({
        ...snapshot(true, 3),
        scope: 'other-account',
        generation: 2,
      });
      await flush();
    });
    expectStyle(container, true);
  } finally {
    cleanup();
  }
});
it('keeps options disabled until authoritative choices arrive', async () => {
  const bridge = createTestExperimentsBridge({
    ...snapshot(true),
    ready: false,
    choicesReady: false,
  });
  const { container, cleanup } = await mount(bridge);
  try {
    expect(trigger(container).disabled).toBe(true);
    await act(async () => {
      bridge.push(snapshot(true, 2));
      await flush();
    });
    expectStyle(container, true);
    expect(trigger(container).disabled).toBe(false);
  } finally {
    cleanup();
  }
});
