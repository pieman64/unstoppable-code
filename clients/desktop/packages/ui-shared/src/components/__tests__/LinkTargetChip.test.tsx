/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LinkTargetChip, type LinkTargetChipProps } from '../LinkTargetChip';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function render(props: LinkTargetChipProps): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<LinkTargetChip {...props} />);
  });
  return { container, root };
}

function cleanup({
  container,
  root,
}: {
  container: HTMLDivElement;
  root: Root;
}): void {
  act(() => root.unmount());
  container.remove();
}

describe('LinkTargetChip', () => {
  it('announces the destination and detail through a polite status', () => {
    const view = render({
      status: 'ready',
      label: 'New worktree on feature/x in canopy',
      detail: 'Adds acme/canopy as a project',
    });
    const status = view.container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-busy')).toBe('false');
    expect(status?.textContent).toContain(
      'New worktree on feature/x in canopy',
    );
    expect(status?.textContent).toContain('Adds acme/canopy as a project');
    expect(
      view.container
        .querySelector('[data-testid="link-target-chip"]')
        ?.getAttribute('data-status'),
    ).toBe('ready');
    cleanup(view);
  });

  it('marks resolving work as busy', () => {
    const view = render({ status: 'resolving', label: 'Checking link…' });
    expect(
      view.container
        .querySelector('[role="status"]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');
    cleanup(view);
  });

  it('runs host actions and names the icon-only dismiss control', () => {
    const onRetry = jest.fn();
    const onDismiss = jest.fn();
    const view = render({
      status: 'blocked',
      label: 'Couldn’t reach GitHub.',
      actions: [{ id: 'retry', label: 'Try again', onSelect: onRetry }],
      onDismiss,
    });
    const retry = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="link-target-chip-action-retry"]',
    );
    const dismiss = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="link-target-chip-dismiss"]',
    );
    expect(retry?.type).toBe('button');
    expect(dismiss?.getAttribute('aria-label')).toBe(
      'Don’t use this link for a worktree',
    );
    act(() => retry?.click());
    act(() => dismiss?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    cleanup(view);
  });

  it('hides dismissal when the host omits it', () => {
    const view = render({ status: 'submitting', label: 'Creating worktree…' });
    expect(
      view.container.querySelector('[data-testid="link-target-chip-dismiss"]'),
    ).toBeNull();
    cleanup(view);
  });
});
