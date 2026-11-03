/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { buttonClassName } from '../Button';
import {
  ExecutionActionButton,
  type ExecutionActionButtonVariant,
} from '../ExecutionActionButton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/** Resolved `class` attribute for a single-variant render. */
function classFor(variant?: ExecutionActionButtonVariant): string {
  const html = renderToString(
    <ExecutionActionButton
      label="Go"
      ariaLabel="Go"
      onClick={(): void => {}}
      variant={variant}
    />,
  );
  return /class="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('ExecutionActionButton keyboard propagation', () => {
  function mount(element: React.ReactElement): {
    container: HTMLDivElement;
    unmount: () => void;
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(element);
    });
    return {
      container,
      unmount: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  function pressEscapeOn(button: HTMLElement): boolean {
    let reachedDocument = false;
    const listener = (): void => {
      reachedDocument = true;
    };
    document.addEventListener('keydown', listener);
    act(() => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    document.removeEventListener('keydown', listener);
    return reachedDocument;
  }

  it('stops keydown at the button by default, for execution rows', () => {
    const { container, unmount } = mount(
      <ExecutionActionButton label="Run" ariaLabel="Run" onClick={() => {}} />,
    );
    const button = container.querySelector('button');
    if (!button) throw new Error('button not rendered');
    expect(pressEscapeOn(button)).toBe(false);
    unmount();
  });

  it('lets Escape bubble to the document when propagation is not stopped', () => {
    // A detail page or dialog closes on a document-level Escape listener;
    // an action inside it must not swallow that shortcut while focused.
    const { container, unmount } = mount(
      <ExecutionActionButton
        label="Add"
        ariaLabel="Add"
        onClick={() => {}}
        stopKeyDownPropagation={false}
      />,
    );
    const button = container.querySelector('button');
    if (!button) throw new Error('button not rendered');
    expect(pressEscapeOn(button)).toBe(true);
    unmount();
  });
});

describe('ExecutionActionButton', () => {
  it('renders the visible label, icon, and accessible label', () => {
    const html = renderToString(
      <ExecutionActionButton
        label="Run"
        ariaLabel="Run script"
        icon={<span data-testid="glyph">▶</span>}
        onClick={(): void => {}}
        dataTestId="run"
      />,
    );
    expect(html).toContain('Run');
    expect(html).toContain('data-testid="glyph"');
    expect(html).toContain('data-testid="run"');
    expect(html).toContain('aria-label="Run script"');
    expect(html).toContain('data-execution-action-button="true"');
  });

  it('renders an icon-only button when the label is empty', () => {
    const html = renderToString(
      <ExecutionActionButton
        label=""
        ariaLabel="Rerun"
        icon={<span data-testid="glyph" />}
        onClick={(): void => {}}
      />,
    );
    // The accessible label still announces the control.
    expect(html).toContain('aria-label="Rerun"');
    expect(html).toContain('data-testid="glyph"');
  });

  it('keeps every variant out of the window drag region', () => {
    const variants: ExecutionActionButtonVariant[] = [
      'default',
      'primary',
      'warning',
      'destructive',
      'destructive-chip',
      'ghost',
      'ghost-destructive',
    ];
    for (const variant of variants) {
      expect(classFor(variant).split(/\s+/)).toContain('electron-no-drag');
    }
  });

  it('collapses the primary launch action to a square icon in a narrow top bar', () => {
    const html = renderToString(
      <ExecutionActionButton
        label="Launch"
        ariaLabel="Launch scripts"
        variant="primary"
        iconOnlyWhenNarrow
        icon={<span data-testid="glyph" />}
        onClick={(): void => {}}
      />,
    );
    const button = (/<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').split(
      /\s+/,
    );
    const label = (
      /data-execution-action-label[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''
    ).split(/\s+/);

    // Below 640px of `@container/topbar` the label drops and the button is a
    // 28px square; above it the label and the wide padding return.
    expect(button).toEqual(
      expect.arrayContaining([
        'w-7',
        'px-0',
        '@[640px]/topbar:w-auto',
        '@[640px]/topbar:px-2.5',
      ]),
    );
    expect(button).not.toContain('px-2.5');
    expect(button).not.toContain('!px-0');
    expect(label).toEqual(
      expect.arrayContaining(['hidden', '@[640px]/topbar:inline']),
    );

    // Without the collapse the primary shell keeps its plain padding.
    expect(classFor('primary').split(/\s+/)).toContain('px-2.5');
    expect(classFor('primary')).not.toContain('@[640px]/topbar');
  });

  it('gives the ghost top-bar action the Launch frame without its fill', () => {
    const shell = (variant: ExecutionActionButtonVariant): string[] =>
      classFor(variant)
        .split(/\s+/)
        .filter((name) =>
          ['h-7', 'rounded-md', 'px-2.5', 'text-xs', 'font-normal'].includes(
            name,
          ),
        );
    // Same height, corners, padding and type as Launch (and Open in).
    expect(shell('ghost')).toEqual(shell('primary'));
    expect(shell('ghost')).toHaveLength(5);
    const ghost = classFor('ghost').split(/\s+/);
    expect(ghost).not.toContain('bg-accent');
    expect(ghost).toContain('hover:bg-subtle');
  });

  it('gives the destructive ghost the ghost frame in destructive ink', () => {
    const shell = (variant: ExecutionActionButtonVariant): string[] =>
      classFor(variant)
        .split(/\s+/)
        .filter((name) =>
          ['h-7', 'rounded-md', 'px-2.5', 'text-xs', 'font-normal'].includes(
            name,
          ),
        );
    expect(shell('ghost-destructive')).toEqual(shell('ghost'));
    const classes = classFor('ghost-destructive').split(/\s+/);
    expect(classes).toContain('fg-destructive');
    expect(classes).toContain('hover:bg-destructive-subtle');
    expect(classes).not.toContain('fg-secondary');
  });

  it('renders a default detail action as the labeled secondary button', () => {
    const html = renderToString(
      <ExecutionActionButton
        label="Reinstall plugin"
        ariaLabel="Reinstall plugin"
        placement="detail"
        onClick={(): void => {}}
      />,
    );
    const cls = (/<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').split(
      /\s+/,
    );
    // Detail actions sit beside Share, so they share its 28px capsule
    // recipe rather than the 24px pipeline-row chip.
    expect(cls).toEqual(
      expect.arrayContaining([
        'h-7',
        'text-xs',
        'font-medium',
        'px-3',
        'rounded-full',
        'bg-quaternary',
        'fg-primary',
      ]),
    );
    expect(cls).not.toContain('h-6');
    expect(cls).not.toContain('text-2xs');
  });

  describe('variant geometry', () => {
    it('default is the neutral pipeline-row action chip', () => {
      const cls = classFor('default');
      expect(cls).toContain('h-6');
      expect(cls).toContain('rounded-md');
      expect(cls).toContain('px-2.5');
      expect(cls).toContain('text-2xs');
      expect(cls).toContain('ring-[length:var(--border-hairline)]');
      expect(cls).toContain('bg-quaternary');
      expect(cls).toContain('shadow-sm');
      expect(cls).toContain('ring-line-secondary');
      expect(cls).toContain('fg-primary');
      expect(cls).not.toMatch(/(^|\s)border(-|\s|$)/);
    });

    it('warning is the same secondary shell as default with warning ink', () => {
      const cls = classFor('warning');
      expect(cls).toContain('h-6');
      expect(cls).toContain('rounded-md');
      expect(cls).toContain('px-2.5');
      expect(cls).toContain('bg-quaternary');
      expect(cls).toContain('shadow-sm');
      expect(cls).toContain('ring-line-secondary');
      expect(cls).toContain('fg-warning');
      expect(cls).not.toContain('bg-warning-subtle');
      expect(cls).not.toContain('ring-line-attention');
      expect(cls).not.toContain('amber-');
      expect(cls).not.toMatch(/(^|\s)border(-|\s|$)/);
    });

    it('destructive-chip is the same secondary shell as default with destructive ink', () => {
      const cls = classFor('destructive-chip');
      expect(cls).toContain('h-6');
      expect(cls).toContain('rounded-md');
      expect(cls).toContain('bg-quaternary');
      expect(cls).toContain('shadow-sm');
      expect(cls).toContain('ring-line-secondary');
      expect(cls).toContain('fg-destructive');
      expect(cls).not.toContain('bg-destructive-subtle');
      expect(cls).not.toContain('ring-line-destructive');
      expect(cls).not.toContain('rose-');
    });

    it('chip tones differ from default by ink only', () => {
      const stripInk = (cls: string): string =>
        cls
          .split(' ')
          .filter((token) => !/^fg-/.test(token))
          .join(' ');
      expect(stripInk(classFor('warning'))).toBe(stripInk(classFor('default')));
      expect(stripInk(classFor('destructive-chip'))).toBe(
        stripInk(classFor('default')),
      );
    });

    it('falls back to the default variant when none is supplied', () => {
      expect(classFor(undefined)).toBe(classFor('default'));
    });

    it('primary matches the compact Launch geometry and primary fill', () => {
      const cls = classFor('primary');
      expect(cls).toContain('h-7');
      expect(cls).toContain('px-2.5');
      expect(cls).toContain('text-xs');
      expect(cls).toContain('font-normal');
      expect(cls).toContain('bg-accent');
      expect(cls).toContain(
        'hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
      );
      expect(cls).toContain('fg-emphasis');
      expect(cls).not.toContain('border');
      expect(cls).not.toContain('h-6');
      expect(cls).not.toContain('py-1');
    });

    it('destructive uses px-2 py-0.5 borderless destructive ink with no persistent fill', () => {
      const cls = classFor('destructive');
      expect(cls).toContain('px-2');
      expect(cls).not.toContain('px-2.5');
      expect(cls).toContain('py-0.5');
      expect(cls).toContain('fg-destructive');
      expect(cls).toContain('hover:bg-destructive-subtle');
      expect(cls).not.toContain('border');
      expect(cls).not.toContain('h-6');
      // The failed-run container fill must never leak onto the Stop control.
      // Only the hover: form may set it; an unprefixed fill would leak.
      expect(cls).not.toMatch(/(^|\s)bg-destructive-subtle/);
    });
  });

  it('renders the disabled attribute when disabled', () => {
    const html = renderToString(
      <ExecutionActionButton
        label="Run"
        ariaLabel="Run"
        onClick={(): void => {}}
        disabled
      />,
    );
    expect(html).toContain('disabled');
  });

  it('dispatches onClick and stops propagation to ancestor handlers', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onClick = jest.fn();
    const onAncestorClick = jest.fn();
    act(() => {
      root.render(
        <div onClick={onAncestorClick}>
          <ExecutionActionButton
            label="Run"
            ariaLabel="Run"
            onClick={onClick}
            dataTestId="run"
          />
        </div>,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="run"]',
    );
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onAncestorClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('does not dispatch onClick while disabled', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onClick = jest.fn();
    act(() => {
      root.render(
        <ExecutionActionButton
          label="Run"
          ariaLabel="Run"
          onClick={onClick}
          disabled
          dataTestId="run"
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="run"]',
    );
    act(() => button?.click());
    expect(onClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
});

describe('ExecutionActionButton on a detail page', () => {
  /** The class tokens of the rendered button. */
  function detailTokens(variant: 'primary' | 'default'): readonly string[] {
    const html = renderToStaticMarkup(
      <ExecutionActionButton
        label="Try it"
        ariaLabel="Try it"
        variant={variant}
        placement="detail"
        onClick={() => {}}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    return (host.querySelector('button')?.className ?? '').split(/\s+/);
  }

  it.each([
    ['primary', 'primary'],
    ['default', 'secondary'],
  ] as const)(
    'draws %s as the capsule %s Button, like Share beside it',
    (variant, buttonVariant) => {
      const tokens = detailTokens(variant);
      expect(tokens).toContain('rounded-full');
      expect(tokens).not.toContain('rounded-md');
      for (const token of buttonClassName({
        variant: buttonVariant,
        size: 'compact',
      }).split(/\s+/)) {
        if (token !== '') expect(tokens).toContain(token);
      }
      // Touch: the recipe's own hit area grows the 28px capsule to 44px on a
      // coarse pointer, without growing the capsule itself.
      expect(tokens).toContain('pointer-coarse:before:-inset-y-2');
      expect(tokens).toContain('before:absolute');
      expect(tokens).not.toContain('pointer-coarse:min-h-11');
    },
  );
});
