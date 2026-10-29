/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorktreeIdStopLaunchButton } from '../WorktreeLaunchStopControl';

const mockEarlyAccess = jest.fn<boolean, []>();
jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess(),
}));
jest.mock('@/hooks/useWorktreeLaunchStop', () => ({
  useWorktreeLaunchStop: jest.fn(),
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('WorktreeIdStopLaunchButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(isLaunchStopping = false): HTMLElement {
    const onStop = jest.fn();
    act(() =>
      root.render(
        <WorktreeIdStopLaunchButton
          worktreeId="dev-lobster"
          isLaunchStopping={isLaunchStopping}
          onStop={onStop}
          testId="stop"
        />,
      ),
    );
    const button = container.querySelector<HTMLElement>('[data-testid="stop"]');
    if (button === null) throw new Error('No stop control');
    return button;
  }

  it('early access: shimmers the id in the line’s own ink, with no spinner or status color', () => {
    mockEarlyAccess.mockReturnValue(true);
    const button = render();
    expect(button.getAttribute('aria-label')).toBe('Stop launch script');
    expect(button.textContent).toBe('dev-lobster');
    // The id is the only content: no spinner, no stop glyph.
    expect(button.querySelector('svg')).toBeNull();
    expect(button.querySelector('.canopy-text-shimmer')?.textContent).toBe(
      'dev-lobster',
    );
    expect(button.classList.contains('fg-info')).toBe(false);
    // Hover still marks it as the stop control.
    expect(button.classList.contains('hover:fg-destructive')).toBe(true);
    // Same 16px bottom-aligned box as the classic control.
    expect(button.classList.contains('h-4')).toBe(true);
    expect(button.classList.contains('align-bottom')).toBe(true);
  });

  it('early access: holds still in the destructive ink while stopping', () => {
    mockEarlyAccess.mockReturnValue(true);
    const button = render(true);
    expect(button.getAttribute('aria-label')).toBe('Stopping launch script');
    expect(button.classList.contains('fg-destructive')).toBe(true);
    expect(button.querySelector('.canopy-text-shimmer')).toBeNull();
  });

  it('uses launch shimmer even with the old choice off', () => {
    mockEarlyAccess.mockReturnValue(false);
    const button = render();
    expect(button.classList.contains('fg-info')).toBe(false);
    expect(button.querySelector('.canopy-text-shimmer')).not.toBeNull();
    expect(button.getAttribute('data-launch-status')).toBe('shimmer');
  });
});
