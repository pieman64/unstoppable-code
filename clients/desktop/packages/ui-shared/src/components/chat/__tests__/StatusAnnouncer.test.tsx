/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  STATUS_ANNOUNCEMENT_DELAY_MS,
  StatusAnnouncer,
  type StatusAnnouncement,
} from '../StatusAnnouncer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('StatusAnnouncer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function render(announcement: StatusAnnouncement | null): void {
    act(() =>
      root.render(
        <StatusAnnouncer
          announcement={announcement}
          privacy="block"
          data-testid="status-announcer"
        />,
      ),
    );
  }

  function region(): HTMLElement | null {
    return container.querySelector('[data-testid="status-announcer"]');
  }

  it('carries the host privacy class on the polite, atomic region', () => {
    render(null);
    expect(region()?.getAttribute('role')).toBe('status');
    expect(region()?.getAttribute('aria-atomic')).toBe('true');
    expect(region()?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('announces identical text again under a new string id', () => {
    render(null);
    render({ id: 'request-a', text: 'Approval needed: Run command' });
    act(() => jest.advanceTimersByTime(STATUS_ANNOUNCEMENT_DELAY_MS));
    expect(region()?.textContent).toBe('Approval needed: Run command');
    render({ id: 'request-b', text: 'Approval needed: Run command' });
    act(() => jest.advanceTimersByTime(0));
    expect(region()?.textContent).toBe('');
    act(() => jest.advanceTimersByTime(STATUS_ANNOUNCEMENT_DELAY_MS));
    expect(region()?.textContent).toBe('Approval needed: Run command');
  });
});
