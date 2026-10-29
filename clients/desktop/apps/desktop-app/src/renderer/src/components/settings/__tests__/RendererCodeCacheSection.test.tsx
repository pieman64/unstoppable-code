/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PreferencesData,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { makeTestPreferences } from '@/test-utils/preferences';
import { RendererCodeCacheSection } from '../RendererCodeCacheSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let loadPreferences: jest.Mock<Promise<PreferencesLoadResult>, []>;
let savePreferences: jest.Mock<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>;
let restartApp: jest.Mock<Promise<boolean>, []>;

function installApi(
  enabled: boolean,
  launch: {
    active?: boolean;
    fellBack?: boolean;
    switchBackFailed?: boolean;
  } = {},
): void {
  loadPreferences = jest
    .fn<Promise<PreferencesLoadResult>, []>()
    .mockResolvedValue({
      ...makeTestPreferences({ rendererCodeCacheSchemeEnabled: enabled }),
      ...(launch.active ? { __rendererCodeCacheSchemeActive: true } : {}),
      ...(launch.fellBack ? { __rendererCodeCacheSchemeFellBack: true } : {}),
      ...(launch.switchBackFailed
        ? { __rendererCodeCacheSchemeSwitchBackFailed: true }
        : {}),
    });
  savePreferences = jest
    .fn<Promise<PreferencesData>, [Partial<PreferencesData>]>()
    .mockImplementation((patch) =>
      Promise.resolve(
        makeTestPreferences({
          rendererCodeCacheSchemeEnabled:
            patch.rendererCodeCacheSchemeEnabled === true,
        }),
      ),
    );
  restartApp = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadPreferences, savePreferences, restartApp },
  });
}

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
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
    root.render(<RendererCodeCacheSection />);
    await settle();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="renderer-code-cache-toggle"]',
  );
  if (!toggle) throw new Error('Expected the experiment toggle.');
  return toggle;
}

function query(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

describe('RendererCodeCacheSection', () => {
  it('renders the row off by default with restart guidance in its description', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      expect(query(container, 'settings-renderer-code-cache')).not.toBeNull();
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      const text = container.textContent ?? '';
      expect(text).toContain('Open windows faster');
      expect(text).toContain(`after you restart ${brandText.appName}`);
      expect(query(container, 'renderer-code-cache-restart')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('reflects a setting this launch already runs with, without a restart prompt', async () => {
    installApi(true, { active: true });
    const { container, cleanup } = await mount();
    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
      expect(query(container, 'renderer-code-cache-restart')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('persists the setting and offers a restart when it differs from this launch', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        toggleOf(container).click();
        await settle();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        rendererCodeCacheSchemeEnabled: true,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
      const notice = query(container, 'renderer-code-cache-restart');
      expect(notice?.textContent).toContain(
        `Restart ${brandText.appName} to apply this change.`,
      );

      const restart = query(container, 'renderer-code-cache-restart-button');
      await act(async () => {
        restart?.click();
        await settle();
      });
      expect(restartApp).toHaveBeenCalledTimes(1);

      // Switching back to the running state needs no restart.
      await act(async () => {
        toggleOf(container).click();
        await settle();
      });
      expect(savePreferences).toHaveBeenLastCalledWith({
        rendererCodeCacheSchemeEnabled: false,
      });
      expect(query(container, 'renderer-code-cache-restart')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('asks for a manual restart when the app cannot restart itself', async () => {
    installApi(false);
    restartApp.mockResolvedValue(false);
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        toggleOf(container).click();
        await settle();
      });
      await act(async () => {
        query(container, 'renderer-code-cache-restart-button')?.click();
        await settle();
      });
      expect(container.textContent).toContain(
        `Quit and reopen ${brandText.appName} to apply this change.`,
      );
    } finally {
      cleanup();
    }
  });

  it('explains a launch that switched itself back off', async () => {
    installApi(false, { fellBack: true });
    const { container, cleanup } = await mount();
    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expect(
        query(container, 'renderer-code-cache-fell-back')?.textContent,
      ).toContain(
        "This was turned off because windows couldn't open this way.",
      );
    } finally {
      cleanup();
    }
  });

  it('rolls back and explains when the save fails', async () => {
    installApi(false);
    savePreferences.mockRejectedValue(new Error('disk full'));
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        toggleOf(container).click();
        await settle();
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expect(container.textContent).toContain('Could not save this setting');
    } finally {
      cleanup();
    }
  });

  it('is built from the Settings kit: a text-only heading over one row in a group', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      const section = query(container, 'settings-renderer-code-cache');
      expect(section?.tagName).toBe('SECTION');
      const heading = section?.querySelector('h2');
      expect(heading?.textContent).toBe('Open windows faster');
      expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
      // The heading holds only text: the toggle lives in a row.
      expect(heading?.parentElement?.querySelector('button')).toBeNull();
      const label = section?.querySelector<HTMLLabelElement>(
        'label[data-settings-row-label]',
      );
      expect(label?.textContent).toBe('Keep app code ready');
      const toggle = toggleOf(container);
      expect(label?.htmlFor).toBe(toggle.id);
      expect(toggle.id).not.toBe('');
      // Hand-rolled section chrome is gone.
      expect(section?.className).not.toContain('rounded-xl');
    } finally {
      cleanup();
    }
  });

  it('explains a launch that could not switch back, without a restart prompt', async () => {
    installApi(true, { active: true, switchBackFailed: true });
    const { container, cleanup } = await mount();
    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
      expect(
        query(container, 'renderer-code-cache-switch-back-failed')?.textContent,
      ).toContain(
        "This is still on because saved window state couldn't be moved back. Turn it off to try again.",
      );
      expect(query(container, 'renderer-code-cache-restart')).toBeNull();

      await act(async () => {
        toggleOf(container).click();
        await settle();
      });
      expect(
        query(container, 'renderer-code-cache-switch-back-failed'),
      ).toBeNull();
      expect(query(container, 'renderer-code-cache-restart')).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});
