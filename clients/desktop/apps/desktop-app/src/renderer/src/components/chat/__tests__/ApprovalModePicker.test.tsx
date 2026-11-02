/**
 * @jest-environment jsdom
 *
 * Follows the repo's createRoot + act jsdom convention used by
 * ModelPicker.test.tsx: the root mounts on document.body so the picker's
 * `createPortal` target (also document.body) is reachable via querySelector,
 * and React's synthetic event delegation still covers the portal subtree.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { ApprovalModePicker } from '../ApprovalModePicker';

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="approval-mode-picker"]',
  );
  if (!el) throw new Error('approval mode picker trigger not found');
  return el;
}

function option(mode: ApprovalMode): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="approval-mode-option-${mode}"]`,
  );
}

function click(el: Element | null): void {
  if (!el) throw new Error('cannot click a null element');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function triggerIcon(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="approval-mode-icon"]',
  );
  if (!el) throw new Error('approval mode trigger icon not found');
  return el;
}

function optionIcon(mode: ApprovalMode): SVGElement | null {
  return document.querySelector<SVGElement>(
    `[data-testid="approval-mode-option-icon-${mode}"]`,
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('ApprovalModePicker', () => {
  it('renders the trigger with the current mode label', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    expect(trigger().textContent).toContain('Ask');
  });

  it('opens the menu with all three options on click', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    expect(option('ask')).toBeNull();

    click(trigger());

    expect(option('ask')).not.toBeNull();
    expect(option('auto')).not.toBeNull();
    expect(option('full-access')).not.toBeNull();
  });

  it('keeps the menu to the three modes, with no footer tip', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    click(trigger());

    expect(
      document.querySelector('[data-testid="approval-mode-picker-hint"]'),
    ).toBeNull();
    expect(
      document.querySelectorAll(
        '[data-testid^="approval-mode-option-"][role="menuitemradio"]',
      ),
    ).toHaveLength(3);
  });

  it('marks the current mode as the selected option', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'auto', onChange: jest.fn() }),
    );
    click(trigger());

    expect(option('auto')?.getAttribute('aria-checked')).toBe('true');
    expect(option('ask')?.getAttribute('aria-checked')).toBe('false');
    expect(option('full-access')?.getAttribute('aria-checked')).toBe('false');
  });

  it('calls onChange with the selected mode and closes the menu', () => {
    const onChange = jest.fn();
    render(createElement(ApprovalModePicker, { mode: 'ask', onChange }));
    click(trigger());

    click(option('full-access'));

    expect(onChange).toHaveBeenCalledWith('full-access');
    expect(option('full-access')).toBeNull();
  });

  it('does not open the menu when disabled', () => {
    render(
      createElement(ApprovalModePicker, {
        mode: 'ask',
        onChange: jest.fn(),
        disabled: true,
      }),
    );

    expect(trigger().disabled).toBe(true);
    click(trigger());
    expect(option('ask')).toBeNull();
  });

  // Only the risky mode takes a color; Ask and Auto rest in the neutral ink.
  it.each([
    ['ask', 'fg-secondary'],
    ['auto', 'fg-secondary'],
    ['full-access', 'fg-destructive'],
  ] as const)(
    'colors the composer trigger icon for %s only when the mode carries risk',
    (mode, colorClass) => {
      render(createElement(ApprovalModePicker, { mode, onChange: jest.fn() }));

      const icon = triggerIcon();
      expect(icon.getAttribute('data-approval-mode')).toBe(mode);
      expect(icon.className).toContain(colorClass);
    },
  );

  it('shows every mode glyph on the left and a trailing check only on the selected row', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    click(trigger());

    expect(optionIcon('ask')).not.toBeNull();
    expect(optionIcon('auto')).not.toBeNull();
    expect(optionIcon('full-access')).not.toBeNull();
    // Row glyphs carry the same ink as the trigger glyph.
    expect(optionIcon('ask')?.parentElement?.className).toContain(
      'fg-secondary',
    );
    expect(optionIcon('auto')?.parentElement?.className).toContain(
      'fg-secondary',
    );
    expect(optionIcon('full-access')?.parentElement?.className).toContain(
      'fg-destructive',
    );
    const check = (mode: ApprovalMode): Element | null =>
      document.querySelector(
        `[data-testid="approval-mode-option-check-${mode}"]`,
      );
    expect(check('ask')).not.toBeNull();
    expect(check('ask')?.className).toContain('ml-auto');
    expect(check('auto')).toBeNull();
    expect(check('full-access')).toBeNull();
  });

  it('renders a distinct glyph per mode', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    click(trigger());

    // Compare the SVG *children* (path/circle geometry) rather than outerHTML,
    // which differs on the test-id attribute alone and would pass vacuously.
    const askGlyph = optionIcon('ask')?.innerHTML ?? '';
    const autoGlyph = optionIcon('auto')?.innerHTML ?? '';
    const fullGlyph = optionIcon('full-access')?.innerHTML ?? '';

    expect(askGlyph).not.toBe('');
    expect(autoGlyph).not.toBe('');
    expect(fullGlyph).not.toBe('');
    expect(new Set([askGlyph, autoGlyph, fullGlyph]).size).toBe(3);
  });

  it('uses the shared capsule trigger geometry of the model and effort controls', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );

    const button = trigger();
    // Same 32px capsule, padding, type size, and hover surface as the shared
    // PickerTrigger recipe used by the neighbouring pickers.
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('px-2.5');
    expect(button.className).toContain('text-xs');
    expect(button.className).toContain('hover:bg-subtle');
    expect(button.className).not.toContain('rounded-md');
    expect(button.className).not.toContain('text-2xs');
    expect(button.className).not.toContain('bg-muted');

    // Glyph-to-label reads as 6px (the icon's pr-1.5; the fold's -mr-1 takes
    // back the capsule's gap-1), the model picker's provider icon inset.
    expect(triggerIcon().className).toContain('pr-1.5');
    expect(
      triggerIcon().closest('[data-fold-open]')?.getAttribute('data-fold-open'),
    ).toBe('true');

    // The label uses the model picker's primary ink, same size and weight.
    const labelSpan = Array.from(button.querySelectorAll('span')).find(
      (span) => span.textContent === 'Ask',
    );
    expect(labelSpan?.className).toContain('fg-primary');
    expect(button.className).not.toContain('font-medium');

    // 14px app glyph and the shared app chevron, not a hand-drawn one.
    const glyph = triggerIcon().querySelector('svg');
    expect(glyph?.getAttribute('data-app-icon')).toBe('true');
    expect(glyph?.getAttribute('width')).toBe('14px');
    expect(glyph?.getAttribute('height')).toBe('14px');
    const svgs = Array.from(button.querySelectorAll('svg'));
    expect(svgs).toHaveLength(2);
    const chevron = svgs[1];
    expect(chevron?.getAttribute('data-app-icon')).toBe('true');
    expect(chevron?.getAttribute('width')).toBe('14px');
    expect(button.querySelector('polyline')).toBeNull();
  });

  it('renders the options as the shared action-menu rows used by context menus', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    click(trigger());

    // Same FloatingMenu surface and DropdownMenuItem rows as the sidebar
    // context menus, with the label carrying its subtitle beneath it.
    expect(
      document.querySelector(
        '[role="menu"][aria-label="Approval mode options"]',
      ),
    ).not.toBeNull();
    const row = option('auto');
    expect(row?.className).toContain('canopy-dropdown-menu-item');
    expect(row?.getAttribute('role')).toBe('menuitemradio');
    // The shared two-line row: its 8px gap plus the copy's 4px margin set
    // the text 12px off the icon, with 8px of padding in place of the
    // single-line row's fixed height.
    expect(row?.className).toContain('gap-2');
    expect(row?.querySelector('.flex-col')?.className).toContain('ml-1');
    expect(row?.className).toContain('py-2');
    expect(row?.className).not.toContain('h-8');
    expect(row?.textContent).toContain('Accept edits');
    // Title (on its own 20px line) and subtitle sit 2px apart.
    expect(row?.querySelector('.flex-col')?.className).toContain('gap-0.5');
    expect(row?.textContent).toContain('Edit project files without asking');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(
      document.querySelector('[data-testid="approval-mode-menu"]')?.className,
    ).toContain('w-70');
  });

  it('gives each mode a one-line subtitle at the bigger size, without clipping', () => {
    render(
      createElement(ApprovalModePicker, { mode: 'ask', onChange: jest.fn() }),
    );
    click(trigger());
    const descriptions: Record<ApprovalMode, string> = {
      ask: 'Ask before running tools',
      auto: 'Edit project files without asking',
      'full-access': 'Skip approvals and safety rules',
    };
    for (const [mode, text] of Object.entries(descriptions)) {
      const description = document.querySelector(
        `[data-testid="approval-mode-option-description-${mode}"]`,
      );
      expect(description?.textContent).toBe(text);
      // Subtitles wrap naturally: no single-line truncation or line clamp.
      expect(description?.className).not.toMatch(/truncate|line-clamp/);
      expect(description?.className).toContain('whitespace-normal');
      expect(description?.className).toContain('text-xs');
      expect(description?.className).not.toContain('text-2xs');
      expect(text.length).toBeLessThan(40);
    }
    expect(document.body.textContent).not.toContain(
      'Prompt before every tool call',
    );
  });

  it('hides the label text in compact mode', () => {
    render(
      createElement(ApprovalModePicker, {
        mode: 'full-access',
        onChange: jest.fn(),
        compact: true,
      }),
    );
    expect(trigger().textContent).not.toContain('Full access');
  });

  it('drops the chevron with the label in compact mode so only the glyph remains', () => {
    render(
      createElement(ApprovalModePicker, {
        mode: 'auto',
        onChange: jest.fn(),
        compact: true,
      }),
    );

    // One SVG: the mode shield. The label-less capsule reads as a single
    // glyph, like the compact effort control beside it.
    expect(trigger().querySelectorAll('svg')).toHaveLength(1);
    expect(triggerIcon().querySelector('svg')).not.toBeNull();
  });

  it('centers the compact glyph by dropping the glyph-to-label margin', () => {
    // `mr-0.5` exists only to pad the glyph from the label. With no label the
    // capsule's symmetric padding centers the glyph, and the leftover margin
    // pushed the shield 1px left of the hover circle's center.
    render(
      createElement(ApprovalModePicker, {
        mode: 'full-access',
        onChange: jest.fn(),
        compact: true,
      }),
    );
    expect(triggerIcon().className).not.toContain('mr-0.5');
  });

  it('still renders the colored mode glyph in the compact Home-composer rail', () => {
    // The compact rail drops the text label, so the glyph is the only thing
    // communicating the mode — it must survive `compact`.
    render(
      createElement(ApprovalModePicker, {
        mode: 'full-access',
        onChange: jest.fn(),
        compact: true,
      }),
    );

    const icon = triggerIcon();
    expect(icon.getAttribute('data-approval-mode')).toBe('full-access');
    expect(icon.className).toContain('fg-destructive');
    expect(icon.querySelector('svg')).not.toBeNull();
  });
  it('keeps the label and drops the glyph in the label compact style', () => {
    // The label names the mode; the glyph is the part a tight row can spare.
    render(
      createElement(ApprovalModePicker, {
        mode: 'full-access',
        onChange: jest.fn(),
        compact: true,
        compactStyle: 'label',
      }),
    );
    expect(trigger().textContent).toContain('Full access');
    // The glyph node stays for automation that reads the mode, but is folded.
    const icon = triggerIcon();
    expect(icon.getAttribute('data-approval-mode')).toBe('full-access');
    expect(
      icon.closest('[data-fold-open]')?.getAttribute('data-fold-open'),
    ).toBe('false');
  });

  it('keeps the chevron beside the label in the label compact style', () => {
    render(
      createElement(ApprovalModePicker, {
        mode: 'auto',
        onChange: jest.fn(),
        compact: true,
        compactStyle: 'label',
      }),
    );
    // Label plus chevron: the chevron is the only drawn SVG.
    const drawn = Array.from(trigger().querySelectorAll('svg')).filter(
      (svg) => !svg.closest('[data-fold-open="false"]'),
    );
    expect(drawn).toHaveLength(1);
    expect(trigger().textContent).toContain('Accept edits');
  });

  it('keeps the full accessible name in the label compact style', () => {
    render(
      createElement(ApprovalModePicker, {
        mode: 'ask',
        onChange: jest.fn(),
        compact: true,
        compactStyle: 'label',
      }),
    );
    expect(trigger().getAttribute('aria-label')).toBe(
      'Tool approval mode, current mode Ask',
    );
  });
});

describe('triggerless mode', () => {
  it('renders no trigger and stays closed on mount', () => {
    // The composer compresses this control out of the rail at the narrowest
    // width and drives it from the "+" menu, so it must occupy no width and
    // must not spring open on the signal value it sees at mount.
    const anchor = createRef<HTMLSpanElement>();
    render(
      createElement(
        'div',
        null,
        createElement('span', { ref: anchor }),
        createElement(ApprovalModePicker, {
          mode: 'ask',
          onChange: (): void => {},
          anchorRef: anchor,
          openSignal: 3,
        }),
      ),
    );

    expect(
      document.querySelector('[data-testid="approval-mode-picker"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="approval-mode-menu"]'),
    ).toBeNull();
  });

  it('opens when the signal increments and reports the chosen mode', () => {
    const anchor = createRef<HTMLSpanElement>();
    const onChange = jest.fn();
    const tree = (signal: number): ReactNode =>
      createElement(
        'div',
        null,
        createElement('span', { ref: anchor }),
        createElement(ApprovalModePicker, {
          mode: 'ask',
          onChange,
          anchorRef: anchor,
          openSignal: signal,
        }),
      );
    render(tree(0));

    act(() => {
      root?.render(tree(1));
    });
    expect(
      document.querySelector('[data-testid="approval-mode-menu"]'),
    ).not.toBeNull();

    act(() => option('auto')?.click());
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('returns focus to the supplied element rather than the hidden anchor', () => {
    // The anchor is an aria-hidden span with no tabindex, so FloatingMenu's
    // default restore is a no-op and focus would fall to <body>.
    const anchor = createRef<HTMLSpanElement>();
    const returnFocus = createRef<HTMLButtonElement>();
    const tree = (signal: number): ReactNode =>
      createElement(
        'div',
        null,
        createElement('button', { ref: returnFocus, type: 'button' }, 'plus'),
        createElement('span', { ref: anchor }),
        createElement(ApprovalModePicker, {
          mode: 'ask',
          onChange: (): void => {},
          anchorRef: anchor,
          openSignal: signal,
          returnFocusRef: returnFocus,
        }),
      );
    render(tree(0));
    act(() => {
      root?.render(tree(1));
    });

    act(() => option('auto')?.click());

    expect(document.activeElement).toBe(returnFocus.current);
    expect(document.activeElement).not.toBe(document.body);
  });
});
