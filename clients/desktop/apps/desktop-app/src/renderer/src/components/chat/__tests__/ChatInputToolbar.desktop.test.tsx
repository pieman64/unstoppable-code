/**
 * @jest-environment jsdom
 */
/**
 * Structural proof for the desktop main-chat composer after it adopted the
 * New Task capsule layout.
 *
 * `ChatInput.tsx` is too heavily store/IPC-bound to mount in jsdom, so this
 * suite renders `ChatComposerToolbar` with the exact prop shape the desktop
 * composer now passes and asserts the capsule spacing, fixed raised action,
 * compact left rail, and persistent-control order. If the shared toolbar drifts
 * from the desktop/New Task hierarchy, these assertions fail.
 *
 * Model, effort, the multi-repo folder picker and context usage are not
 * toolbar slots on desktop: they render in the status row under the composer
 * box (`chat-composer-status-row`, covered by `composer-density.spec.mjs`),
 * so the mirror omits them.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatComposerToolbar } from '@canopy/ui-shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function cleanup(container: HTMLDivElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/**
 * Mirrors the desktop `ChatInput` toolbar invocation (idle, non-compact,
 * watched, with a scheduled draft). Secondary actions live behind the
 * fixed leading `+`, so only persistent controls are supplied to the rails.
 */
function renderDesktopToolbar(
  overrides: Partial<Parameters<typeof ChatComposerToolbar>[0]> = {},
): { container: HTMLDivElement; root: Root } {
  return render(
    <ChatComposerToolbar
      capsuleLayout
      compact={false}
      leadingSlot={
        <button
          data-testid="chat-input-plus-button"
          aria-label="More actions"
          className="h-8 w-8 rounded-full"
        />
      }
      scheduledSendSlot={<button data-testid="scheduled-send-chip" />}
      watchersSlot={<button data-testid="chat-input-watchers-chat" />}
      planMode={{
        variant: 'capsule',
        onClick: (): void => {},
        active: true,
        ariaPressed: true,
        ariaLabel: 'Plan mode',
        icon: <svg data-testid="plan-icon" />,
        label: 'Plan',
        dataTestId: 'chat-input-plan-mode-inline-button',
      }}
      trailingSlot={
        <button data-testid="send-button" aria-label="Send message" />
      }
      {...overrides}
    />,
  );
}

describe('desktop composer toolbar (ChatComposerToolbar)', () => {
  it('renders the New Task capsule spacing on the desktop row', () => {
    const { container, root } = renderDesktopToolbar();
    const row = container.firstElementChild;
    // Home's `justify-between gap-2 p-2` rhythm, bottom-aligned so + and
    // send sit on the last line when the chips wrap.
    for (const cls of [
      'flex',
      'items-end',
      'justify-between',
      'gap-2',
      'p-2',
    ]) {
      expect(row?.classList.contains(cls)).toBe(true);
    }
    expect(row?.classList.contains('pb-2.5')).toBe(false);
    cleanup(container, root);
  });

  it('wraps the capsule left rail instead of scrolling it sideways', () => {
    const { container, root } = renderDesktopToolbar();
    const innerRail = container.querySelector('.scrollbar-hide');
    expect(innerRail?.hasAttribute('data-composer-toolbar-rail')).toBe(true);
    for (const cls of [
      'flex',
      'min-w-0',
      'flex-1',
      'flex-wrap',
      'items-center',
      'overflow-hidden',
      'gap-2',
    ]) {
      expect(innerRail?.classList.contains(cls)).toBe(true);
    }
    expect(innerRail?.classList.contains('overflow-x-auto')).toBe(false);
    expect(container.querySelector('[aria-label="Scroll left"]')).toBeNull();
    expect(container.querySelector('[aria-label="Scroll right"]')).toBeNull();
    cleanup(container, root);
  });

  it('keeps the raised plus action fixed outside the left rail', () => {
    const { container, root } = renderDesktopToolbar();
    const plus = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-plus-button"]',
    );
    expect(plus?.classList.contains('h-8')).toBe(true);
    expect(plus?.classList.contains('rounded-full')).toBe(true);
    expect(plus?.getAttribute('aria-label')).toBe('More actions');
    expect(
      container.querySelector('.scrollbar-hide')?.contains(plus ?? null),
    ).toBe(false);
    cleanup(container, root);
  });

  it('preserves the desktop left-rail control order', () => {
    const { container, root } = renderDesktopToolbar();
    const html = container.innerHTML;
    const order = [
      'data-testid="chat-input-plus-button"',
      'data-testid="chat-input-plan-mode-inline-button"',
      'data-testid="scheduled-send-chip"',
      'data-testid="chat-input-watchers-chat"',
    ];
    let previous = -1;
    for (const marker of order) {
      const idx = html.indexOf(marker);
      expect(idx).toBeGreaterThan(previous);
      previous = idx;
    }
    cleanup(container, root);
  });

  it('preserves the desktop right-rail control order', () => {
    const { container, root } = renderDesktopToolbar({
      terminalLabelSlot: <span data-testid="terminal-label" />,
      voiceSlot: <button data-testid="voice-button" />,
      shareSlot: <button data-testid="share-button" />,
      scheduleSlot: <button data-testid="schedule-button" />,
      interfaceToggleSlot: <button data-testid="interface-toggle" />,
    });
    const html = container.innerHTML;
    const order = [
      'data-testid="terminal-label"',
      'data-testid="voice-button"',
      'data-testid="share-button"',
      'data-testid="interface-toggle"',
      'data-testid="send-button"',
    ];
    let previous = -1;
    for (const marker of order) {
      const idx = html.indexOf(marker);
      expect(idx).toBeGreaterThan(previous);
      previous = idx;
    }
    cleanup(container, root);
  });

  it('keeps capsule spacing stable when compact measurement is active', () => {
    const { container, root } = renderDesktopToolbar({ compact: true });
    const row = container.firstElementChild;
    expect(row?.classList.contains('flex-nowrap')).toBe(true);
    expect(row?.classList.contains('flex-wrap')).toBe(false);
    expect(row?.classList.contains('gap-2')).toBe(true);
    expect(row?.classList.contains('gap-1')).toBe(false);
    expect(row?.classList.contains('p-2')).toBe(true);
    expect(
      container.querySelector('.scrollbar-hide')?.classList.contains('gap-2'),
    ).toBe(true);
    cleanup(container, root);
  });
});
