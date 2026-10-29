/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOADING_PLACEHOLDER_DELAY_MS } from '../../lib/useDelayedFlag';
import { DelayedLoadingPlaceholder } from '../DelayedLoadingPlaceholder';
import { SettingsListSkeleton } from '../SettingsSkeletons';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function placeholder(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="delayed-loading-placeholder"]',
  );
}

describe('DelayedLoadingPlaceholder', () => {
  it('reserves its box at once and shows the placeholder after the delay', () => {
    act(() => {
      root.render(
        <DelayedLoadingPlaceholder className="mt-4">
          <SettingsListSkeleton />
        </DelayedLoadingPlaceholder>,
      );
    });
    const box = placeholder();
    expect(box?.classList.contains('invisible')).toBe(true);
    expect(box?.classList.contains('mt-4')).toBe(true);
    expect(box?.getAttribute('data-visible')).toBe('false');
    // Mounted and laid out from t=0, only hidden.
    expect(
      box?.querySelector('[data-testid="settings-skeleton-list"]'),
    ).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(LOADING_PLACEHOLDER_DELAY_MS - 1);
    });
    expect(placeholder()?.classList.contains('invisible')).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(placeholder()?.classList.contains('invisible')).toBe(false);
    expect(placeholder()?.getAttribute('data-visible')).toBe('true');
    // Appears in one step: no fade or transition.
    expect(placeholder()?.className).not.toMatch(/transition|animate-|fade/);
  });

  it('honours a custom delay', () => {
    act(() => {
      root.render(
        <DelayedLoadingPlaceholder delayMs={500}>
          <span />
        </DelayedLoadingPlaceholder>,
      );
    });
    act(() => {
      jest.advanceTimersByTime(LOADING_PLACEHOLDER_DELAY_MS);
    });
    expect(placeholder()?.classList.contains('invisible')).toBe(true);
    act(() => {
      jest.advanceTimersByTime(500 - LOADING_PLACEHOLDER_DELAY_MS);
    });
    expect(placeholder()?.classList.contains('invisible')).toBe(false);
  });

  it('cancels its timer when content arrives inside the window', () => {
    act(() => {
      root.render(
        <DelayedLoadingPlaceholder>
          <span />
        </DelayedLoadingPlaceholder>,
      );
    });
    expect(jest.getTimerCount()).toBe(1);
    act(() => {
      root.render(<p>Content</p>);
    });
    expect(placeholder()).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });
});
