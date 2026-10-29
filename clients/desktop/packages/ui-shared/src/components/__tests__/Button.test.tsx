/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { Button, type ButtonSize, type ButtonVariant } from '../Button';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Button', () => {
  it('uses the standardized geometry by default', () => {
    const html = renderToStaticMarkup(<Button>Continue</Button>);

    expect(html).toContain('type="button"');
    expect(html).toContain('max-h-9');
    expect(html).toContain('h-8');
    expect(html).toContain('rounded-full');
    expect(html).toContain('text-s');
  });

  it('maps the primary variant to the semantic accent with a surface overlay', () => {
    const html = renderToStaticMarkup(
      <Button variant="primary">Continue</Button>,
    );

    expect(html).toContain('bg-accent');
    // Primary hover darkens the accent with a solid 12% black color-mix
    // (not a translucent gradient overlay).
    expect(html).toContain(
      'hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
    );
    expect(html).toContain('fg-emphasis');
    expect(html).not.toContain('hover:bg-accent-hover');
    expect(html).not.toContain('hover:bg-accent/90');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toMatch(/text-(?:white|black)/);
  });

  it('keeps destructive states opaque for reliable text contrast', () => {
    const html = renderToStaticMarkup(
      <Button variant="destructive">Delete</Button>,
    );

    expect(html).toContain('bg-destructive');
    expect(html).toContain('fg-emphasis');
    expect(html).toContain('hover:bg-destructive-hover');
    expect(html).not.toContain('hover:bg-destructive/90');
  });

  it('keeps color feedback instant while retaining press motion', () => {
    const html = renderToStaticMarkup(<Button>Continue</Button>);

    expect(html).toContain('transition-[opacity,transform]');
    expect(html).not.toContain('background-color,color');
  });

  it('uses the surface shadow for secondary buttons', () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary">Continue</Button>,
    );

    expect(html).toContain('bg-quaternary');
    expect(html).toContain('shadow-sm');
    // Secondary is the house secondary control surface: the same quaternary
    // shell, elevation, and hairline ring as the header `Open in` pill.
    expect(html).toContain('ring-[length:var(--border-hairline)]');
    expect(html).toContain('ring-line-secondary');
    expect(html).toContain('fg-primary');
    // Secondary keeps the subtle-gradient hover wash.
    expect(html).toContain(
      'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    expect(html).not.toContain('hover:bg-muted');
    // The shadow intentionally stays on press; only the scale changes.
    expect(html).not.toContain('active:shadow-none');
  });

  it.each<ButtonVariant>([
    'primary',
    'outline',
    'ghost',
    'warning',
    'destructive',
  ])('keeps the %s variant free of the secondary surface shadow', (variant) => {
    const html = renderToStaticMarkup(
      <Button variant={variant}>Continue</Button>,
    );

    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('ring-line-secondary');
  });

  it('uses semantic warning colors and explicit disabled tokens', () => {
    const html = renderToStaticMarkup(
      <Button variant="warning" disabled>
        Convert
      </Button>,
    );

    expect(html).toContain('bg-warning-subtle');
    expect(html).toContain('fg-warning');
    expect(html).toContain('disabled:bg-[var(--bg-disabled)]');
    expect(html).toContain('disabled:text-[var(--fg-disabled)]');
    expect(html).toContain('disabled:opacity-100');
  });

  it('reads as unavailable while aria-disabled without leaving the tab order', () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" aria-disabled aria-busy>
        Connecting…
      </Button>,
    );

    expect(html).toContain('aria-disabled:cursor-not-allowed');
    expect(html).toContain('aria-disabled:opacity-60');
    expect(html).toContain('aria-disabled="true"');
  });

  it.each<[ButtonSize, string]>([
    ['sm', 'h-7'],
    ['md', 'h-8'],
    ['lg', 'h-9'],
  ])('keeps the %s size within the 36px maximum', (size, heightClass) => {
    const html = renderToStaticMarkup(<Button size={size}>Action</Button>);

    expect(html).toContain(heightClass);
    expect(html).toContain('max-h-9');
  });

  it('renders the control size as the 28px rounded rectangle with a 13px label', () => {
    const html = renderToStaticMarkup(<Button size="control">Browse</Button>);

    expect(html).toContain('h-7');
    expect(html).toContain('rounded-md');
    expect(html).toContain('text-xs');
    expect(html).toContain('px-2.5');
    expect(html).not.toContain('rounded-full');
    expect(html).not.toContain('text-s ');
  });

  it('renders a square control-size icon button', () => {
    const html = renderToStaticMarkup(
      <Button size="control" variant="ghost" iconOnly aria-label="Delete">
        x
      </Button>,
    );

    expect(html).toContain('w-7');
    expect(html).toContain('rounded-md');
    expect(html).not.toContain('rounded-full');
  });

  it('renders the compact size as the 28px capsule with the 13px label and 12px sides', () => {
    const html = renderToStaticMarkup(<Button size="compact">Browse</Button>);

    expect(html).toContain('h-7');
    expect(html).toContain('rounded-full');
    expect(html).toContain('text-xs');
    expect(html).toContain('px-3');
    expect(html).not.toContain('px-2.5');
    expect(html).not.toContain('rounded-md');
    expect(html).not.toContain('text-s ');
  });

  it('renders a round compact icon button', () => {
    const html = renderToStaticMarkup(
      <Button size="compact" variant="ghost" iconOnly aria-label="Delete">
        x
      </Button>,
    );

    expect(html).toContain('w-7');
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('rounded-md');
  });

  it('renders a square icon-only control while preserving its accessible name', () => {
    const html = renderToStaticMarkup(
      <Button iconOnly size="lg" aria-label="Add item">
        +
      </Button>,
    );

    expect(html).toContain('w-9');
    expect(html).toContain('aria-label="Add item"');
  });

  it('lets a checklist row act as the button when it fills the row', () => {
    const html = renderToStaticMarkup(
      <Button iconOnly variant="ghost" size="sm" aria-label="Run" fillRow>
        go
      </Button>,
    );
    const plain = renderToStaticMarkup(
      <Button iconOnly variant="ghost" size="sm" aria-label="Run">
        go
      </Button>,
    );

    // The row's hover paints the ghost hover look, an overlay covering the
    // row (its 8px radius) takes the click, and the button is positioned by
    // the row rather than itself, without the press scale.
    expect(html).toContain('group-hover/checklist:bg-secondary');
    expect(html).toContain('group-hover/checklist:fg-primary');
    expect(html).toContain('after:absolute');
    expect(html).toContain('after:inset-0');
    expect(html).toContain('after:rounded-lg');
    expect(html).toContain('before:hidden');
    expect(html).toContain('position:static');
    expect(html).toContain('scale:none');
    expect(plain).not.toContain('group-hover/checklist');
    expect(plain).not.toContain('after:absolute');
    expect(plain).not.toContain('position:static');
  });

  it('forwards native props and refs', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const ref = createRef<HTMLButtonElement>();

    act(() => {
      root.render(
        <Button ref={ref} disabled data-testid="save">
          Save
        </Button>,
      );
    });

    expect(ref.current).toBe(container.querySelector('button'));
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.dataset.testid).toBe('save');

    act(() => root.unmount());
  });
});
