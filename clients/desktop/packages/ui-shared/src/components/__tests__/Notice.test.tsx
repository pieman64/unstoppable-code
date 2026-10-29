/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ComposerNoticeStack,
  Notice,
  NoticeButton,
  NoticeShapeProvider,
} from '../Notice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Notice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function query<T extends HTMLElement>(selector: string): T | null {
    return container.querySelector<T>(selector);
  }

  it('is a polite status on the neutral house surface by default', () => {
    const html = renderToStaticMarkup(<Notice>Plain message</Notice>);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-notice-intent="neutral"');
    // The surface is the recessed depth tray with a hairline ring and no
    // elevation: quieter than the composer, no tinted fill, no `border-*`
    // utility (inert in this app), no raw palette class.
    expect(html).toContain('bg-base');
    expect(html).not.toMatch(/shadow-/);
    expect(html).toContain('ring-line-secondary');
    expect(html).not.toMatch(/border-line-|bg-warning|bg-info|amber-|sky-/);
    expect(html).toContain('fg-primary');
  });

  it('carries the intent on the glyph ink only and escalates destructive to an alert', () => {
    const attention = renderToStaticMarkup(
      <Notice intent="attention">Careful</Notice>,
    );
    expect(attention).toContain('fg-warning');
    expect(attention).toContain('role="status"');
    expect(attention).not.toContain('bg-warning');

    const destructive = renderToStaticMarkup(
      <Notice intent="destructive">Broken</Notice>,
    );
    expect(destructive).toContain('fg-destructive');
    expect(destructive).toContain('role="alert"');
    expect(destructive).toContain('aria-live="assertive"');
    expect(destructive).not.toContain('bg-destructive');
  });

  it('renders static prose with no live region when role is none', () => {
    const html = renderToStaticMarkup(
      <Notice intent="attention" role="none">
        Part of the page
      </Notice>,
    );
    expect(html).not.toContain('role=');
    expect(html).not.toContain('aria-live=');
    // Still the same surface and glyph; only the announcement changes.
    expect(html).toContain('fg-warning');
    expect(html).toContain('bg-base');
  });

  it('honors an explicit role and a hidden icon column', () => {
    const html = renderToStaticMarkup(
      <Notice intent="destructive" role="status" icon={null}>
        Quiet
      </Notice>,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<svg');
  });

  it('renders title, message, detail and actions in reading order', () => {
    act(() =>
      root.render(
        <Notice
          data-testid="notice"
          title="Heading"
          detail={<span data-testid="detail">Consequence</span>}
          actions={
            <NoticeButton variant="secondary" data-testid="action">
              Do it
            </NoticeButton>
          }
        >
          Message
        </Notice>,
      ),
    );

    const text = query('[data-testid="notice"]')?.textContent ?? '';
    expect(text.indexOf('Heading')).toBeLessThan(text.indexOf('Message'));
    expect(text.indexOf('Message')).toBeLessThan(text.indexOf('Consequence'));
    expect(text.indexOf('Consequence')).toBeLessThan(text.indexOf('Do it'));
    expect(query('[data-testid="action"]')?.tagName).toBe('BUTTON');
  });

  it.each([
    ['a bare title', 'Sending paused', 'Sending paused.'],
    [
      'a title that already ends in a stop',
      'Not ready to start:',
      'Not ready to start:',
    ],
    ['a wrapped title', <span data-testid="t">Run paused</span>, 'Run paused.'],
    [
      'a fragment title that already ends in a stop',
      <>Can&apos;t delete {'llama3'} yet.</>,
      "Can't delete llama3 yet.",
    ],
    [
      'a fragment title without a stop',
      <>No response for {6} minutes</>,
      'No response for 6 minutes.',
    ],
  ])('closes %s with exactly one full stop', (_label, title, expected) => {
    act(() => root.render(<Notice title={title}>Message</Notice>));
    expect(query('span.fg-primary')?.textContent).toBe(expected);
  });

  it('renders an accessible dismiss control only when asked, and no empty column otherwise', () => {
    act(() => root.render(<Notice data-testid="notice">Message</Notice>));
    expect(query('button')).toBeNull();
    // No reserved dismiss column: a non-dismissible notice's trailing
    // buttons reach the surface inset instead of stopping 28px short of it.
    expect(query('span.w-7[aria-hidden="true"]')).toBeNull();

    const onDismiss = jest.fn();
    act(() =>
      root.render(
        <Notice
          data-testid="notice"
          onDismiss={onDismiss}
          dismissLabel="Dismiss the thing"
          dismissTestId="notice-dismiss"
        >
          Message
        </Notice>,
      ),
    );
    const dismiss = query<HTMLButtonElement>('[data-testid="notice-dismiss"]');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss the thing');
    // A Central glyph, never a typed `×`.
    expect(dismiss?.querySelector('svg')).not.toBeNull();
    expect(dismiss?.textContent).toBe('');
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('places actions trailing by default and on their own row when asked', () => {
    const trailing = renderToStaticMarkup(
      <Notice actions={<NoticeButton variant="secondary">Go</NoticeButton>}>
        Message
      </Notice>,
    );
    expect(trailing).toContain('data-notice-actions="trailing"');
    expect(trailing).not.toContain('data-notice-actions="below"');

    const below = renderToStaticMarkup(
      <Notice
        actionsPlacement="below"
        actions={<NoticeButton variant="secondary">Go</NoticeButton>}
      >
        Message
      </Notice>,
    );
    expect(below).toContain('data-notice-actions="below"');
    expect(below).not.toContain('data-notice-actions="trailing"');
    // Aligned with the copy: indented past the glyph column.
    expect(below).toMatch(/data-notice-actions="below" class="[^"]*pl-6/);
  });

  it('spreads data attributes and placement classes onto the root', () => {
    const html = renderToStaticMarkup(
      <Notice data-testid="x" data-state="open" className="mb-4">
        Message
      </Notice>,
    );
    expect(html).toContain('data-testid="x"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('mb-4');
  });
});

describe('Notice composer shape', () => {
  function shapeOf(html: string): {
    surface: string;
    dismiss: string;
    actions: string;
  } {
    const host = document.createElement('div');
    host.innerHTML = html;
    const surface = host.querySelector('[data-notice-intent]');
    return {
      surface: surface?.className ?? '',
      dismiss:
        host.querySelector('button[aria-label="Dismiss"]')?.className ?? '',
      actions:
        host.querySelector('[data-notice-actions="trailing"]')?.className ?? '',
    };
  }

  it('keeps the 16px panel notice by default', () => {
    const { surface, dismiss } = shapeOf(
      renderToStaticMarkup(
        <Notice onDismiss={(): void => undefined}>Plain message</Notice>,
      ),
    );
    expect(surface).toContain('rounded-xl');
    expect(surface).toContain('py-2');
    expect(dismiss).toContain('-mr-1');
  });

  it('leaves the surface to its host with surface="none", keeping its geometry', () => {
    const html = renderToStaticMarkup(
      <Notice surface="none" onDismiss={(): void => undefined}>
        In a toast card
      </Notice>,
    );
    const { surface, dismiss } = shapeOf(html);
    expect(html).toContain('data-notice-surface="none"');
    expect(surface).not.toContain('bg-base');
    expect(surface).not.toContain('ring-line-secondary');
    expect(surface).not.toContain('rounded-xl');
    // Same inset and dismiss position, so the card's 16px corners still nest
    // the 8px dismiss box.
    expect(surface).toContain('px-3');
    expect(surface).toContain('py-2');
    expect(dismiss).toContain('-mr-1');
  });

  it('stacks the title over the message with titleLayout="stacked"', () => {
    const html = renderToStaticMarkup(
      <Notice title="Push failed" titleLayout="stacked">
        Pull, then push again.
      </Notice>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const stacked = host.querySelector('[data-notice-title-layout="stacked"]');
    const [titleLine, messageLine] = Array.from(stacked?.children ?? []);
    // Two lines, and no stop added to the title.
    expect(titleLine?.textContent).toBe('Push failed');
    expect(titleLine?.className).toContain('fg-primary');
    expect(messageLine?.textContent).toBe('Pull, then push again.');
    expect(messageLine?.className).toContain('fg-tertiary');
  });

  it("steps a toast's stacked message up to fg-secondary", () => {
    const html = renderToStaticMarkup(
      <Notice title="mosquito" titleLayout="stacked" shape="toast">
        Chat finished.
      </Notice>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const stacked = host.querySelector('[data-notice-title-layout="stacked"]');
    expect(stacked?.children[1]?.className).toContain('fg-secondary');
  });

  it('gives a toast 16px to the copy and nests its close button in 20px corners', () => {
    const { surface, dismiss } = shapeOf(
      renderToStaticMarkup(
        <Notice shape="toast" onDismiss={(): void => undefined}>
          A toast
        </Notice>,
      ),
    );
    // 11px plus the copy's 5px line inset = 16px; 16px on the left.
    expect(surface).toContain('py-2.75');
    expect(surface).toContain('pl-4');
    // The close button sits 12px from the top and right: 20 = 8 + 12.
    expect(surface).toContain('pr-3');
    expect(surface).toContain('rounded-2xl');
    expect(dismiss).toContain('mt-px');
    expect(dismiss).not.toContain('-mr-1');
  });

  it('gives a toast the 32px pill with each label lined up with the copy', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <Notice
        shape="toast"
        actionsPlacement="below"
        actions={<NoticeButton>Open</NoticeButton>}
      >
        A toast
      </Notice>,
    );
    const button = host.querySelector('button');
    expect(button?.className).toContain('h-8');
    expect(button?.className).toContain('px-3');
    // 16px row inset + the pill's 12px = the copy's 28px (16px glyph + 12px).
    const row = host.querySelector('[data-notice-actions="below"]');
    expect(row?.className).toContain('pl-4');
    expect(row?.className).not.toContain('pl-7');

    // Banners keep the 28px pill.
    const banner = document.createElement('div');
    banner.innerHTML = renderToStaticMarkup(
      <Notice actions={<NoticeButton>Open</NoticeButton>}>A banner</Notice>,
    );
    expect(banner.querySelector('button')?.className).toContain('h-7');
    expect(banner.querySelector('button')?.className).toContain('px-2.5');
  });

  it('takes the composer corners under a composer provider', () => {
    const html = renderToStaticMarkup(
      <NoticeShapeProvider shape="composer">
        <Notice onDismiss={(): void => undefined}>On the composer</Notice>
      </NoticeShapeProvider>,
    );
    const { surface, dismiss } = shapeOf(html);
    // 20px corners over 8px controls at the full 12px inset (20 = 8 + 12).
    expect(html).toContain('data-notice-shape="composer"');
    expect(surface).toContain('rounded-2xl');
    expect(surface).toContain('py-3');
    expect(surface).not.toContain('rounded-xl');
    expect(dismiss).not.toContain('-mr-1');
    // The composer's own geometry: an 8px edge and a 32px glyph column (the
    // + button's width), then 12px to the copy, so the glyph centres over +
    // and the copy starts where the composer's text does.
    expect(surface).toContain('pl-2');
    const host = document.createElement('div');
    host.innerHTML = html;
    const glyph = host.querySelector('[data-notice-intent] span[aria-hidden]');
    expect(glyph?.className).toContain('w-8');
    expect(glyph?.parentElement?.className).toContain('gap-3');
  });

  it('centres the glyph on a wrapped message on the composer, not elsewhere', () => {
    const glyphRow = (html: string): string => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return (
        host.querySelector('[data-notice-intent] span[aria-hidden]')
          ?.parentElement?.className ?? ''
      );
    };
    const composer = glyphRow(
      renderToStaticMarkup(
        <Notice shape="composer" title="This session has been archived">
          Messages are read-only.
        </Notice>,
      ),
    );
    expect(composer).toContain('items-center');
    expect(composer).not.toContain('items-start');
    const panel = glyphRow(
      renderToStaticMarkup(<Notice title="Saved">Done.</Notice>),
    );
    expect(panel).toContain('items-start');
  });

  it('keeps trailing buttons at the full inset without a dismiss control', () => {
    const { actions } = shapeOf(
      renderToStaticMarkup(
        <Notice
          shape="composer"
          actions={
            <NoticeButton onClick={(): void => undefined}>Go</NoticeButton>
          }
        >
          Pick one
        </Notice>,
      ),
    );
    expect(actions).not.toContain('-mr-1');
  });
});

describe('Notice settings shape', () => {
  function surfaceOf(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    const surface = host.querySelector<HTMLElement>('[data-notice-intent]');
    if (!surface) throw new Error('Missing notice surface');
    return surface;
  }

  it('matches the settings card: 12px corners and a 16px inset', () => {
    const surface = surfaceOf(
      renderToStaticMarkup(
        <NoticeShapeProvider shape="settings">
          <Notice
            onDismiss={(): void => undefined}
            actions={
              <NoticeButton onClick={(): void => undefined}>Go</NoticeButton>
            }
          >
            On a settings page
          </Notice>
        </NoticeShapeProvider>,
      ),
    );
    expect(surface.getAttribute('data-notice-shape')).toBe('settings');
    expect(surface.className).toContain('rounded-lg');
    expect(surface.className).toContain('px-4');
    expect(surface.className).toContain('py-3');
    expect(surface.className).not.toContain('rounded-xl');
    expect(surface.className).not.toContain('px-3');
    // Controls end on the card's 16px edge, like a settings row's control.
    expect(
      surface.querySelector('button[aria-label="Dismiss"]')?.className,
    ).not.toContain('-mr-1');
  });

  it('keeps trailing buttons on the 16px edge without a dismiss control', () => {
    const surface = surfaceOf(
      renderToStaticMarkup(
        <Notice
          shape="settings"
          actions={
            <NoticeButton onClick={(): void => undefined}>Go</NoticeButton>
          }
        >
          Pick one
        </Notice>,
      ),
    );
    expect(
      surface.querySelector('[data-notice-actions="trailing"]')?.className,
    ).not.toContain('-mr-1');
  });

  it('gives its buttons the compact capsule with the settings label size', () => {
    const surface = surfaceOf(
      renderToStaticMarkup(
        <Notice
          shape="settings"
          actions={
            <NoticeButton variant="primary" onClick={(): void => undefined}>
              Go
            </NoticeButton>
          }
        >
          Pick one
        </Notice>,
      ),
    );
    const button = surface.querySelector('button')?.className ?? '';
    expect(button).toContain('rounded-full');
    expect(button).toContain('text-xs');
    expect(button).not.toContain('text-s ');
  });

  it('keeps the small capsule on other notices', () => {
    const surface = surfaceOf(
      renderToStaticMarkup(
        <Notice
          actions={
            <NoticeButton onClick={(): void => undefined}>Go</NoticeButton>
          }
        >
          Pick one
        </Notice>,
      ),
    );
    const button = surface.querySelector('button')?.className ?? '';
    expect(button).toContain('rounded-full');
    expect(button).toContain('text-s ');
  });
});

describe('ComposerNoticeStack', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function Hidden(): null {
    return null;
  }

  function stack(): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="stack"]',
    );
    if (!element) throw new Error('stack missing');
    return element;
  }

  it('renders nothing visible and no children when every notice is hidden', () => {
    act(() =>
      root.render(
        <ComposerNoticeStack data-testid="stack">
          {null}
          {false}
          <Hidden />
        </ComposerNoticeStack>,
      ),
    );
    // `:empty` only matches a node with no children, so the stack stays
    // out of the composer column instead of reserving its margin.
    expect(stack().childNodes).toHaveLength(0);
    expect(stack().className.split(' ')).toEqual(
      expect.arrayContaining(['empty:hidden', 'mb-2']),
    );
  });

  it('stacks one or several notices with composer corners and one gap owner', () => {
    act(() =>
      root.render(
        <ComposerNoticeStack data-testid="stack">
          <Notice>First</Notice>
          <Hidden />
          <Notice shape="default">Second</Notice>
        </ComposerNoticeStack>,
      ),
    );
    const notices = stack().querySelectorAll('[data-notice-shape]');
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute('data-notice-shape')).toBe('composer');
    // A notice that names its own shape keeps it.
    expect(notices[1]?.getAttribute('data-notice-shape')).toBe('default');
    expect(stack().className.split(' ')).toEqual(
      expect.arrayContaining(['flex', 'flex-col', 'gap-2']),
    );
  });
});
