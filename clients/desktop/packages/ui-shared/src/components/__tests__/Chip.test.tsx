/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { FileIcon } from '../../icons/AppIcons';
import { Chip } from '../Chip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Chip', () => {
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

  const render = (node: JSX.Element): void => {
    act(() => root.render(node));
  };

  it('is plain text in a 24px rounded rectangle when nothing can be done with it', () => {
    const html = renderToStaticMarkup(<Chip>Fast</Chip>);
    expect(html).not.toContain('<button');
    expect(html).toContain('h-6');
    expect(html).toContain('rounded-md');
    expect(html).toContain('text-xs');
    expect(html).toContain('>Fast<');
  });

  it('draws a leading icon before the label', () => {
    const html = renderToStaticMarkup(<Chip icon={FileIcon}>README.md</Chip>);
    expect(html.indexOf('<svg')).toBeGreaterThan(-1);
    expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('README.md'));
  });

  it('acts on click with the Button hover and press, never a color fade', () => {
    const onClick = jest.fn();
    render(<Chip onClick={onClick}>Fast</Chip>);
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Fast');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.className).toContain('focus-ring');
    const chip = container.querySelector('[data-chip]');
    expect(chip?.className).toContain('has-[[data-chip-main]:hover]:bg-muted');
    expect(chip?.className).toContain(
      'has-[[data-chip-main]:active]:opacity-70',
    );
    expect(chip?.className).not.toMatch(/transition-colors|transition-all/);
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows its title in the shared tooltip, never as a native title', () => {
    render(
      <Chip onClick={jest.fn()} title="Open README.md" data-testid="chip">
        README.md
      </Chip>,
    );
    const chip = container.querySelector('[data-testid="chip"]');
    expect(container.querySelector('[title]')).toBeNull();
    act(() => {
      chip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Open README.md');
    expect(
      container.querySelector('button')?.getAttribute('aria-describedby'),
    ).toBe(tooltip?.id);
  });

  it('removes through its own named button without acting on the chip', () => {
    const onClick = jest.fn();
    const onRemove = jest.fn();
    render(
      <Chip onClick={onClick} onRemove={onRemove}>
        README.md
      </Chip>,
    );
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove README.md"]',
    );
    expect(remove).not.toBeNull();
    act(() => remove?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('names the remove button from removeLabel when the label is not text', () => {
    render(
      <Chip
        onRemove={jest.fn()}
        removeLabel="Remove attachment"
        removeTestId="attachment-remove"
      >
        <span>file</span>
      </Chip>,
    );
    expect(
      container.querySelector('button[aria-label="Remove attachment"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="attachment-remove"]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove attachment');
  });

  it('disables every action and dims when disabled', () => {
    const onClick = jest.fn();
    const onRemove = jest.fn();
    render(
      <Chip onClick={onClick} onRemove={onRemove} disabled>
        README.md
      </Chip>,
    );
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(onClick).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    const chip = container.querySelector('[data-chip]');
    expect(chip?.className).toContain('opacity-40');
    // The chip stays the click target, so a click on it is swallowed rather
    // than handed to a clickable row behind it, like a disabled Button.
    expect(chip?.className).not.toContain('pointer-events-none');
    expect(chip?.className).toContain('cursor-not-allowed');
    // Disabled, it neither lights up nor presses.
    expect(chip?.className).not.toContain('bg-muted');
    expect(chip?.className).not.toContain('scale-97');
  });

  it('lights and presses the chip only from its own action, never from remove', () => {
    render(
      <Chip onClick={jest.fn()} onRemove={jest.fn()}>
        README.md
      </Chip>,
    );
    const chip = container.querySelector('[data-chip]');
    const tokens = chip?.className.split(/\s+/) ?? [];
    // A bare hover or active on the chip would also fire while the pointer
    // is on the remove button, hiding its hover and pressing the whole chip.
    expect(tokens.filter((token) => /^(hover|active):/.test(token))).toEqual(
      [],
    );
    expect(
      container.querySelector('button')?.hasAttribute('data-chip-main'),
    ).toBe(true);
  });

  it('eases its press and gives the remove button a touch-sized hit area', () => {
    render(
      <Chip onClick={jest.fn()} onRemove={jest.fn()}>
        README.md
      </Chip>,
    );
    const chip = container.querySelector('[data-chip]');
    // Tailwind 4's scale-* sets the CSS scale property.
    expect(chip?.className).toMatch(/transition-\[[^\]]*\bscale\b[^\]]*\]/);
    const remove = container.querySelector(
      'button[aria-label="Remove README.md"]',
    );
    expect(remove?.className).toContain('pointer-coarse:before:-inset-1.5');
  });

  it('truncates a long label instead of growing past its placement width', () => {
    const html = renderToStaticMarkup(
      <Chip className="max-w-40">
        a-very-long-file-name-that-keeps-going.ts
      </Chip>,
    );
    expect(html).toContain('max-w-40');
    expect(html).toMatch(/class="[^"]*min-w-0 truncate[^"]*"/);
  });

  it('can be forced into its hover or pressed look for a state gallery', () => {
    const html = renderToStaticMarkup(
      <Chip onClick={jest.fn()} forcedState="pressed">
        Fast
      </Chip>,
    );
    expect(html).toContain('data-forced-state="pressed"');
    expect(html).toContain('data-[forced-state=pressed]:opacity-70');
    expect(html).toContain('data-[forced-state=hover]:bg-muted');
  });

  it('can force only the remove button into its hover look', () => {
    const html = renderToStaticMarkup(
      <Chip onRemove={jest.fn()} forcedState="remove-hover">
        README.md
      </Chip>,
    );
    expect(html).toMatch(
      /<button[^>]*aria-label="Remove README.md"[^>]*data-forced-state="hover"/,
    );
    expect(html).toContain('data-[forced-state=hover]:bg-muted');
    expect(html.match(/data-forced-state=/g)).toHaveLength(1);
  });

  it('is a toggle with an accent selected look and a leading check', () => {
    const onClick = jest.fn();
    render(
      <Chip onClick={onClick} selected icon={FileIcon} actionTestId="toggle">
        Research
      </Chip>,
    );
    const button = container.querySelector('[data-testid="toggle"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    // The check replaces the icon: one glyph, before the label.
    expect(button?.querySelectorAll('svg')).toHaveLength(1);
    const chip = container.querySelector('[data-chip]');
    expect(chip?.className).toContain('bg-accent-subtle');
    expect(chip?.className).toContain('fg-accent');
    expect(chip?.classList.contains('bg-subtle')).toBe(false);
    // Hover and press stay on the accent tint.
    expect(chip?.className).toContain(
      'has-[[data-chip-main]:hover]:bg-accent-subtle/80',
    );
    expect(chip?.className).not.toContain(
      'has-[[data-chip-main]:hover]:bg-muted',
    );
    act(() => (button as HTMLButtonElement | null)?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is an unpressed toggle with the neutral look and no check when not selected', () => {
    render(
      <Chip onClick={jest.fn()} selected={false} actionTestId="toggle">
        Research
      </Chip>,
    );
    const button = container.querySelector('[data-testid="toggle"]');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.querySelector('svg')).toBeNull();
    const chip = container.querySelector('[data-chip]');
    expect(chip?.className).toContain('bg-subtle');
    expect(chip?.className).not.toContain('bg-accent-subtle');
  });

  it('is not a toggle when selected is not given', () => {
    render(<Chip onClick={jest.fn()}>Fast</Chip>);
    expect(
      container.querySelector('button')?.hasAttribute('aria-pressed'),
    ).toBe(false);
  });

  it('hands aria-describedby to its action button', () => {
    render(
      <Chip onClick={jest.fn()} aria-describedby="hint">
        Fast
      </Chip>,
    );
    expect(
      container.querySelector('button')?.getAttribute('aria-describedby'),
    ).toBe('hint');
  });
});
