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
import { ActivityCardSettingsRow } from '../ActivityCardSettingsRow';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
const sidebar = { id: 'activity-card', requiresEarlyAccess: false };
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
    root.render(<ActivityCardSettingsRow />);
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
function toggle(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    '[data-testid="settings-activity-card-toggle"]',
  );
  if (!element) throw new Error('Missing Activity card switch');
  return element;
}
afterEach(() => {
  resetLabsExperimentsStoreForTest();
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
  else Reflect.deleteProperty(window, 'api');
});
it.each([false, true])(
  'preserves the saved Activity card choice (%s)',
  async (enabled) => {
    const bridge = createTestExperimentsBridge(snapshot(enabled));
    bridge.respondWith(() => Promise.resolve(snapshot(!enabled, 2)));
    const { container, cleanup } = await mount(bridge);
    try {
      expect(toggle(container).getAttribute('aria-checked')).toBe(
        String(enabled),
      );
      await act(async () => {
        toggle(container).click();
        await flush();
      });
      expect(toggle(container).getAttribute('aria-checked')).toBe(
        String(!enabled),
      );
    } finally {
      cleanup();
    }
  },
);
