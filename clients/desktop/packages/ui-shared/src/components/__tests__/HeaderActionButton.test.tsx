/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HeaderActionButton,
  HeaderActionDefaultToneContext,
} from '../HeaderActionButton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('HeaderActionButton', () => {
  it('provides the compact accent action used by headers and activity cards', () => {
    const html = renderToStaticMarkup(
      <HeaderActionButton data-testid="action">Create PR</HeaderActionButton>,
    );

    expect(html).toContain('data-header-action-button="true"');
    expect(html).toContain('h-7');
    expect(html).toContain('rounded-md');
    expect(html).toContain('text-xs');
    expect(html).toContain('font-normal');
    expect(html).toContain('fg-accent');
    expect(html).toContain('hover:bg-accent-subtle');
    expect(html).toContain('px-2.5');
    expect(html).not.toContain('rounded-full');
  });

  it('offers a destructive tone with the same shell for trash-bound actions', () => {
    const html = renderToStaticMarkup(
      <HeaderActionButton tone="destructive">Empty trash</HeaderActionButton>,
    );

    expect(html).toContain('h-7');
    expect(html).toContain('fg-destructive');
    expect(html).not.toContain('fg-accent');
    expect(html).toContain('hover:bg-destructive-subtle');
  });

  it('renders icon-only actions with the same square shell and an accessible name', () => {
    const html = renderToStaticMarkup(
      <HeaderActionButton iconOnly aria-label="Collapse section">
        <svg />
      </HeaderActionButton>,
    );

    expect(html).toContain('aria-label="Collapse section"');
    expect(html).toContain('w-7');
    expect(html).toContain('px-0');
  });

  it('shows the accessible action label in the shared tooltip on focus', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <HeaderActionButton iconOnly aria-label="Refresh section">
          <svg />
        </HeaderActionButton>,
      );
    });

    const button = container.querySelector('button');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => focusViaKeyboard(button));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Refresh section',
    );

    act(() => root.unmount());
    container.remove();
  });

  it("shows a labeled control's `title` in the shared tooltip, never as a native title (CAN-2799)", () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <HeaderActionButton title="Create a pull request for this branch">
          Create PR
        </HeaderActionButton>,
      );
    });

    const button = container.querySelector('button');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => focusViaKeyboard(button));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Create a pull request for this branch',
    );

    act(() => root.unmount());
    container.remove();
  });

  it('stays lit while the enclosing git-action group is hovered', () => {
    const accent = renderToStaticMarkup(
      <HeaderActionButton groupHover>Create PR</HeaderActionButton>,
    );
    const destructive = renderToStaticMarkup(
      <HeaderActionButton tone="destructive" groupHover>
        Empty trash
      </HeaderActionButton>,
    );
    const plain = renderToStaticMarkup(
      <HeaderActionButton>Create PR</HeaderActionButton>,
    );

    // The cancel ✕ is an overlay inside the group but outside the pill, so
    // the pill keeps its hover surface while the pointer is on it.
    expect(accent).toContain('enabled:group-hover/gitaction:bg-accent-subtle');
    expect(destructive).toContain(
      'enabled:group-hover/gitaction:bg-destructive-subtle',
    );
    expect(plain).not.toContain('group-hover/gitaction');
  });

  it('fades a control that stays visible while disabled only when asked', () => {
    const quiet = renderToStaticMarkup(
      <HeaderActionButton iconOnly aria-label="Refresh" quietWhenDisabled>
        ↻
      </HeaderActionButton>,
    );
    const plain = renderToStaticMarkup(
      <HeaderActionButton iconOnly aria-label="Refresh">
        ↻
      </HeaderActionButton>,
    );

    expect(quiet).toContain('disabled:opacity-80');
    expect(plain).not.toContain('disabled:opacity-80');
    // Both still drop pointer interaction while disabled.
    expect(quiet).toContain('disabled:pointer-events-none');
  });

  /**
   * Whether the control mounts inside the shared tooltip's trigger wrapper.
   * A disabled button cannot take focus, so this reads the markup instead.
   */
  function hasTooltip(element: JSX.Element): boolean {
    return renderToStaticMarkup(element).startsWith('<span');
  }

  it('keeps the established disabled and pressed looks by default', () => {
    const html = renderToStaticMarkup(
      <HeaderActionButton
        iconOnly
        tone="neutral"
        aria-label="Back"
        aria-pressed={false}
        disabled
      >
        <svg />
      </HeaderActionButton>,
    );
    expect(html).not.toContain('disabled:fg-disabled');
    expect(html).not.toContain('aria-pressed:bg-subtle');
    expect(
      hasTooltip(
        <HeaderActionButton iconOnly aria-label="Back" disabled>
          <svg />
        </HeaderActionButton>,
      ),
    ).toBe(true);
  });

  it('dims, drops its name tooltip, and shows pressed in the toolbar style', () => {
    const html = renderToStaticMarkup(
      <HeaderActionButton
        iconOnly
        tone="neutral"
        stateStyle="toolbar"
        aria-label="Back"
        disabled
      >
        <svg />
      </HeaderActionButton>,
    );
    expect(html).toContain('disabled:fg-disabled');
    expect(html).toContain('aria-pressed:bg-subtle aria-pressed:fg-primary');
    expect(
      hasTooltip(
        <HeaderActionButton
          iconOnly
          stateStyle="toolbar"
          aria-label="Back"
          disabled
        >
          <svg />
        </HeaderActionButton>,
      ),
    ).toBe(false);
    // An explicit reason still shows.
    expect(
      hasTooltip(
        <HeaderActionButton
          iconOnly
          stateStyle="toolbar"
          aria-label="Back"
          tooltipLabel="No earlier page"
          disabled
        >
          <svg />
        </HeaderActionButton>,
      ),
    ).toBe(true);
  });

  it('supports neutral and warning action tones without changing geometry', () => {
    const neutral = renderToStaticMarkup(
      <HeaderActionButton tone="neutral">Settings</HeaderActionButton>,
    );
    const warning = renderToStaticMarkup(
      <HeaderActionButton tone="warning">Resume</HeaderActionButton>,
    );

    expect(neutral).toContain('fg-secondary');
    expect(warning).toContain('fg-warning');
    expect(neutral).toContain('rounded-md');
    expect(warning).toContain('rounded-md');
  });

  it('takes its default tone from the surface, while a named tone wins', () => {
    const html = renderToStaticMarkup(
      <HeaderActionDefaultToneContext.Provider value="neutral">
        <HeaderActionButton data-testid="default">Refresh</HeaderActionButton>
        <HeaderActionButton data-testid="named" tone="warning">
          Resume
        </HeaderActionButton>
      </HeaderActionDefaultToneContext.Provider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('[data-testid="default"]')?.className).toContain(
      'fg-secondary',
    );
    expect(host.querySelector('[data-testid="named"]')?.className).toContain(
      'fg-warning',
    );
    // Without a provider the action keeps the accent.
    expect(
      renderToStaticMarkup(<HeaderActionButton>Refresh</HeaderActionButton>),
    ).not.toContain('fg-secondary');
  });
});
