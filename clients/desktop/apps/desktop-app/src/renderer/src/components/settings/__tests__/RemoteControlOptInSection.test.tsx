/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { RemoteControlOptInSection } from '../RemoteControlOptInSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let savePreferences: jest.Mock<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>;

function installApi(): void {
  savePreferences = jest
    .fn<Promise<PreferencesData>, [Partial<PreferencesData>]>()
    .mockImplementation((patch) => Promise.resolve(makeTestPreferences(patch)));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { savePreferences },
  });
}

async function render(initialEnabled: boolean): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<RemoteControlOptInSection initialEnabled={initialEnabled} />);
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function toggle(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-testid="remote-control-opt-in-toggle"]',
  );
  if (!element) throw new Error('Remote control toggle missing');
  return element;
}

describe('RemoteControlOptInSection', () => {
  beforeEach(() => {
    installApi();
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('shows the saved choice', async () => {
    const { container, cleanup } = await render(true);
    expect(toggle(container).getAttribute('aria-checked')).toBe('true');
    cleanup();
  });

  it('saves the remote control preference when switched', async () => {
    const { container, cleanup } = await render(false);
    expect(toggle(container).getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      toggle(container).click();
      await Promise.resolve();
    });
    expect(savePreferences).toHaveBeenCalledWith({
      remoteControlEnabled: true,
    });
    expect(toggle(container).getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      toggle(container).click();
      await Promise.resolve();
    });
    expect(savePreferences).toHaveBeenLastCalledWith({
      remoteControlEnabled: false,
    });
    expect(toggle(container).getAttribute('aria-checked')).toBe('false');
    cleanup();
  });

  it('rolls back and explains a failed save', async () => {
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const { container, cleanup } = await render(false);

    await act(async () => {
      toggle(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toggle(container).getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(
      'Could not save this setting. Try again.',
    );
    cleanup();
  });
});
