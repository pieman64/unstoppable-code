/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityItemRow } from '../ActivityItemRow';
import { ActivityItemDensityContext } from '../activity-item-density';
import {
  HeaderActionButton,
  HeaderActionDefaultToneContext,
} from '../HeaderActionButton';

function markup(
  secondaryContent?: ReactNode,
  icon?: ReactNode,
  actions?: ReactNode,
): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <ActivityItemRow
      label={<span data-testid="name">Invocation</span>}
      labelTitle="Description"
      dataTestId="row"
      icon={icon}
      secondaryContent={secondaryContent}
    >
      {actions}
    </ActivityItemRow>,
  );
  return container;
}

describe('ActivityItemRow', () => {
  it('keeps the action mounted when optional metadata appears or disappears', () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (secondaryContent?: ReactNode): void => {
      act(() =>
        root.render(
          <ActivityItemRow
            label="Invocation"
            secondaryContent={secondaryContent}
          >
            <button>Share</button>
          </ActivityItemRow>,
        ),
      );
    };
    try {
      render();
      const action = container.querySelector('button');
      expect(action).not.toBeNull();
      action?.focus();
      for (const metadata of [
        <span key="metadata">From plugin</span>,
        undefined,
        null,
        false,
      ]) {
        render(metadata);
        expect(container.querySelector('button')).toBe(action);
        expect(document.activeElement).toBe(action);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  it('preserves default child placement, titles, markers, and icon accessibility', () => {
    const container = markup(undefined, <svg />, <button>Share</button>);
    const row = container.querySelector('[data-testid="row"]');
    expect(row?.getAttribute('data-activity-item-row')).toBe('true');
    expect(row?.children).toHaveLength(3);
    expect(row?.children[0].getAttribute('aria-hidden')).toBe('true');
    expect(row?.children[1].getAttribute('title')).toBe('Description');
    expect(row?.children[2].tagName).toBe('BUTTON');
  });

  it.each([undefined, null, false])(
    'preserves the identical one-line structure for %s metadata',
    (secondary) => {
      expect(markup(secondary, <svg />, <button>Share</button>).innerHTML).toBe(
        markup(undefined, <svg />, <button>Share</button>).innerHTML,
      );
      expect(
        markup(secondary).querySelector('[data-testid="row"]')?.children,
      ).toHaveLength(1);
    },
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'keeps metadata separate with icon=%s and actions=%s',
    (hasIcon, hasActions) => {
      const container = markup(
        <span data-testid="metadata">From plugin</span>,
        hasIcon ? <svg /> : undefined,
        hasActions ? <button>Share</button> : undefined,
      );
      const row = container.querySelector('[data-testid="row"]');
      const metadata = container.querySelector('[data-testid="metadata"]');
      const name = container.querySelector('[data-testid="name"]');
      expect(metadata?.parentElement).toBe(row?.lastElementChild);
      expect(name?.parentElement?.contains(metadata ?? null)).toBe(false);
      expect(metadata?.parentElement?.querySelector('button')).toBeNull();
      expect(container.querySelectorAll('button')).toHaveLength(
        hasActions ? 1 : 0,
      );
      expect(container.querySelectorAll('svg')).toHaveLength(hasIcon ? 1 : 0);
      expect(row?.children).toHaveLength(
        2 + Number(hasIcon) + Number(hasActions),
      );
    },
  );

  it('retains zero and empty-string React content rather than treating them as absent', () => {
    expect(
      markup(0).querySelector('[data-testid="row"]')?.lastElementChild
        ?.textContent,
    ).toBe('0');
    expect(
      markup('').querySelector('[data-testid="row"]')?.children,
    ).toHaveLength(2);
  });

  it('drops the item card for a plain 28px row in compact density', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ActivityItemDensityContext.Provider value="compact">
        <ActivityItemRow label="Build" dataTestId="row" />
      </ActivityItemDensityContext.Provider>,
    );
    const row = container.querySelector('[data-testid="row"]');
    expect(row?.className).toContain('min-h-7');
    expect(row?.className).toContain('hover:bg-subtle');
    expect(row?.className).not.toContain('border');
  });

  it("lets a surface set the header actions' default tone", () => {
    const html = renderToStaticMarkup(
      <HeaderActionDefaultToneContext.Provider value="neutral">
        <HeaderActionButton iconOnly aria-label="Refresh" tooltipLabel="">
          R
        </HeaderActionButton>
        <HeaderActionButton tone="accent">Explicit</HeaderActionButton>
      </HeaderActionDefaultToneContext.Provider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const [neutral, accent] = Array.from(host.querySelectorAll('button'));
    expect(neutral?.className).toContain('fg-secondary');
    expect(neutral?.className).not.toContain('fg-accent');
    expect(accent?.className).toContain('fg-accent');
  });
});
