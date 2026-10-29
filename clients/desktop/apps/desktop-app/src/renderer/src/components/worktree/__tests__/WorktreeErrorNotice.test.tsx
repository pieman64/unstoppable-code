/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useProjectsStore } from '@/stores/projectsStore';
import { WorktreeErrorNotice } from '../WorktreeErrorNotice';

const HEADER =
  'Command failed while creating the binturong worktree from develop.';

/** A worktree-create failure shaped like the real ~7.8 KB git output. */
function buildPayload(separator: string): string {
  const lines = [
    HEADER,
    "Preparing worktree (new branch 'binturong-1791357289421')",
  ];
  for (let index = 0; lines.join(separator).length < 7800; index += 1) {
    lines.push(`Updating files:  ${index % 100}% (${index}/400)`);
    lines.push(
      `error: unable to create file src/generated/file-${index}.ts: No space left on device`,
    );
  }
  return lines.join(separator);
}

describe('WorktreeErrorNotice', (): void => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useProjectsStore.setState({ worktreeError: null });
  });

  afterEach((): void => {
    act(() => root.unmount());
    document.body.replaceChildren();
    useProjectsStore.setState({ worktreeError: null });
  });

  function render(): void {
    act(() => root.render(<WorktreeErrorNotice />));
  }

  function setError(worktreeError: string | null): void {
    act(() => useProjectsStore.setState({ worktreeError }));
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function notice(): HTMLElement {
    const element = byTestId('worktree-error-notice');
    if (element === null) throw new Error('notice not rendered');
    return element;
  }

  function openDetails(): void {
    act(() => byTestId('worktree-error-details')?.click());
  }

  function pressEscape(): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
  }

  it('renders nothing without an error', (): void => {
    render();
    expect(container.innerHTML).toBe('');
  });

  it('shows only the first line and the cause of a long failure', (): void => {
    setError(buildPayload('\n'));
    render();

    const text = notice().textContent ?? '';
    expect(text.length).toBeLessThan(400);
    expect(text).toContain(HEADER);
    expect(text).toContain('No space left on device');
    expect(text).not.toContain('Updating files:');
    expect(notice().getAttribute('role')).toBe('alert');
    expect(byTestId('worktree-error-details')?.textContent).toBe(
      'Show details',
    );
  });

  it('summarizes a carriage-return payload like a newline one', (): void => {
    setError(buildPayload('\n'));
    render();
    const newlineText = notice().textContent;

    setError(buildPayload('\r'));
    expect(notice().textContent).toBe(newlineText);
  });

  it('opens the full output in a scrolling, replay-blocked dialog', (): void => {
    const payload = buildPayload('\n');
    setError(payload);
    render();

    openDetails();

    expect(byTestId('worktree-error-details-dialog')).not.toBeNull();
    const body = byTestId('worktree-error-details-dialog-body');
    expect(body?.textContent).toBe(payload);
    expect(body?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(body?.classList.contains('overflow-y-auto')).toBe(true);
    expect(body?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('closes the dialog on Escape and keeps the notice', (): void => {
    setError(buildPayload('\n'));
    render();
    openDetails();

    pressEscape();

    expect(byTestId('worktree-error-details-dialog')).toBeNull();
    expect(byTestId('worktree-error-notice')).not.toBeNull();
  });

  it('clears the error when dismissed', (): void => {
    setError(buildPayload('\n'));
    render();

    act(() => byTestId('worktree-error-dismiss')?.click());

    expect(useProjectsStore.getState().worktreeError).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('closes the dialog when the error is cleared elsewhere', (): void => {
    setError(buildPayload('\n'));
    render();
    openDetails();

    setError(null);
    expect(byTestId('worktree-error-details-dialog')).toBeNull();

    setError(buildPayload('\n'));
    expect(byTestId('worktree-error-notice')).not.toBeNull();
    expect(byTestId('worktree-error-details-dialog')).toBeNull();
  });

  it('does not reopen the dialog after a short error replaced a long one', (): void => {
    setError(buildPayload('\n'));
    render();
    openDetails();

    setError('Failed to create worktree');
    expect(byTestId('worktree-error-details-dialog')).toBeNull();

    setError(buildPayload('\r'));
    expect(byTestId('worktree-error-notice')).not.toBeNull();
    expect(byTestId('worktree-error-details-dialog')).toBeNull();
  });

  it('renders a short message whole without Show details', (): void => {
    setError('Failed to create worktree');
    render();

    expect(notice().textContent).toContain('Failed to create worktree');
    expect(byTestId('worktree-error-details')).toBeNull();
  });
});
