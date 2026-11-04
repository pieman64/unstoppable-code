/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LedgerFeedFilters,
  LedgerViewFilters,
} from '@canopy/protocol/ledger-view';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import { LedgerFeedFilterMenu, LedgerFilterMenu } from '../LedgerFilterMenu';
import {
  LedgerEntryTypeAvatar,
  LedgerEntryTypeLabel,
} from '../LedgerEntryTypeLabel';
import { LedgerStatusLabel } from '../LedgerStatusLabel';
import { LedgerStatusPill } from '../LedgerStatusPill';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return element;
}

const STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
  'INFO',
];

/**
 * Foreground roles the theme defines: `fg-x` paints `--color-fg-x`, and a
 * class with no such token in `styles/canopy-tokens.css` paints nothing.
 */
const THEME_FOREGROUND_ROLES: ReadonlySet<string> = new Set([
  'fg-secondary',
  'fg-tertiary',
  'fg-info',
  'fg-success-strong',
  'fg-destructive-strong',
  'fg-warning-strong',
  'fg-special-strong',
  'fg-attention',
  'fg-warning',
]);

function foregroundClasses(element: Element): string[] {
  return Array.from(element.classList).filter((name) => name.startsWith('fg-'));
}

function hasThemeToken(className: string): boolean {
  return THEME_FOREGROUND_ROLES.has(className.split('/')[0] ?? '');
}

describe('Ledger status colors', () => {
  it('inks every status label with a role the theme defines', () => {
    for (const status of STATUSES) {
      act(() =>
        root.render(<LedgerStatusLabel status={status} data-testid="label" />),
      );
      const label = byTestId('label');
      const inks = foregroundClasses(label);
      expect(inks).toHaveLength(1);
      // A class with no token behind it paints nothing: the status would
      // read in the surrounding gray.
      expect({
        status,
        ink: inks[0],
        defined: hasThemeToken(inks[0] ?? ''),
      }).toEqual({ status, ink: inks[0], defined: true });
    }
  });

  it('tells open work apart from finished and failed work by its ink', () => {
    const inkOf = (status: LedgerStatus): string | undefined => {
      act(() =>
        root.render(<LedgerStatusLabel status={status} data-testid="label" />),
      );
      return foregroundClasses(byTestId('label'))[0];
    };
    const inks = new Set([
      inkOf('IN_PROGRESS'),
      inkOf('COMPLETED'),
      inkOf('FAILED'),
      inkOf('NEEDS_REVIEW'),
    ]);
    expect(inks.size).toBe(4);
  });
});

describe('LedgerFeedFilterMenu page trigger', () => {
  const FEED_NONE: LedgerFeedFilters = {
    types: [],
    statuses: [],
    owner: 'anyone',
    author: 'anyone',
    period: 'any',
    includeArchived: false,
  };

  it('is the quiet Filter dropdown with a row per group, each opening its choices', () => {
    const onChange = jest.fn();
    act(() =>
      root.render(
        <LedgerFeedFilterMenu
          trigger="page"
          filters={{
            ...FEED_NONE,
            types: ['TASK'],
            statuses: ['BLOCKED', 'TODO'],
            author: 'you',
          }}
          onChange={onChange}
        />,
      ),
    );
    const trigger = byTestId('ledger-filter-trigger');
    expect(trigger.textContent).toBe('Filter · 3');
    expect(trigger.getAttribute('aria-label')).toBe('Filter entries: 3 on');
    expect(trigger.className).toContain('h-7');
    expect(
      document.querySelector('[data-testid="ledger-filter-active-dot"]'),
    ).toBeNull();
    act(() => trigger.click());
    expect(
      [
        'ledger-filter-type',
        'ledger-filter-status',
        'ledger-filter-owner',
        'ledger-filter-author',
        'ledger-filter-period',
        'ledger-filter-archived',
      ].map((testId) => byTestId(testId).textContent),
    ).toEqual([
      'Type',
      'Status',
      'Owner',
      'Added by',
      'Last changed',
      'Archived',
    ]);
    // A group whose filter is on keeps the selected surface.
    expect(
      byTestId('ledger-filter-status').getAttribute('data-contains-selection'),
    ).toBe('true');
    expect(
      byTestId('ledger-filter-owner').getAttribute('data-contains-selection'),
    ).toBeNull();
    act(() => byTestId('ledger-filter-period').click());
    act(() => byTestId('ledger-filter-period-option-week').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...FEED_NONE,
      types: ['TASK'],
      statuses: ['BLOCKED', 'TODO'],
      author: 'you',
      period: 'week',
    });
    act(() => byTestId('ledger-filter-trigger-clear').click());
    expect(onChange).toHaveBeenLastCalledWith(FEED_NONE);
  });
});

describe('LedgerStatusPill', () => {
  it('names every status beside its own glyph, on a tint the theme defines', () => {
    const glyphs = new Set<string>();
    for (const status of STATUSES) {
      act(() =>
        root.render(<LedgerStatusPill status={status} data-testid="pill" />),
      );
      const pill = byTestId('pill');
      expect(pill.getAttribute('data-status')).toBe(status);
      expect(pill.textContent?.length).toBeGreaterThan(0);
      for (const className of foregroundClasses(pill)) {
        expect({ className, defined: hasThemeToken(className) }).toEqual({
          className,
          defined: true,
        });
      }
      const glyph = pill.querySelector('[data-testid="ledger-status-glyph"]');
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
      glyphs.add(glyph?.outerHTML.replace(status, '') ?? '');
    }
    // One shape per status: color is never the only signal.
    expect(glyphs.size).toBe(STATUSES.length);
  });
});

describe('LedgerEntryTypeAvatar', () => {
  it("shows a type's own glyph on a disc at each size, and the label can drop its glyph beside it", () => {
    act(() =>
      root.render(
        <div>
          <LedgerEntryTypeAvatar type="DECISION" size="small" />
          <LedgerEntryTypeLabel type="DECISION" />
        </div>,
      ),
    );
    const avatar = byTestId('ledger-entry-type-avatar');
    expect(avatar.getAttribute('data-type')).toBe('DECISION');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.className).toContain('h-6');
    // The same glyph the label shows beside the type's name.
    const labelGlyph = byTestId('ledger-entry-type').querySelector('svg');
    expect(avatar.querySelector('svg')?.innerHTML).toBe(labelGlyph?.innerHTML);

    act(() =>
      root.render(
        <div>
          <LedgerEntryTypeAvatar type="TASK" size="large" />
          <LedgerEntryTypeLabel type="TASK" icon={false} />
        </div>,
      ),
    );
    expect(byTestId('ledger-entry-type-avatar').className).toContain('h-8');
    const label = byTestId('ledger-entry-type');
    expect(label.textContent).toBe('Task');
    expect(label.querySelector('svg')).toBeNull();
  });
});

describe('LedgerEntryTypeLabel', () => {
  it('gives every type its own icon, beside its name', () => {
    const types = [
      'TASK',
      'ACTION',
      'DECISION',
      'OBSERVATION',
      'SUMMARY',
    ] as const;
    act(() =>
      root.render(
        <div>
          {types.map((type) => (
            <LedgerEntryTypeLabel key={type} type={type} />
          ))}
        </div>,
      ),
    );
    const labels = Array.from(
      container.querySelectorAll('[data-testid="ledger-entry-type"]'),
    );
    expect(labels.map((label) => label.textContent)).toEqual([
      'Task',
      'Action',
      'Decision',
      'Observation',
      'Summary',
    ]);
    const icons = labels.map((label) =>
      label.querySelector('[data-testid="ledger-entry-type-icon"]'),
    );
    expect(icons.map((icon) => icon?.getAttribute('data-type'))).toEqual([
      ...types,
    ]);
    // Decorative: the name beside it says the type.
    for (const icon of icons) {
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
    // Distinct glyphs, not one icon five times.
    expect(new Set(icons.map((icon) => icon?.innerHTML)).size).toBe(5);
  });
});

describe('LedgerFilterMenu', () => {
  const NONE: LedgerViewFilters = { types: [], statuses: [], owner: 'anyone' };

  it('toggles a type, a status and the owner, and marks an active filter', () => {
    const onChange = jest.fn();
    act(() =>
      root.render(<LedgerFilterMenu filters={NONE} onChange={onChange} />),
    );
    expect(
      document.querySelector('[data-testid="ledger-filter-active-dot"]'),
    ).toBeNull();
    act(() => byTestId('ledger-filter-trigger').click());
    expect(
      byTestId('ledger-filter-type-decision').querySelector(
        '[data-testid="ledger-entry-type-icon"][data-type="DECISION"]',
      ),
    ).not.toBeNull();

    act(() => byTestId('ledger-filter-type-decision').click());
    expect(onChange).toHaveBeenLastCalledWith({ ...NONE, types: ['DECISION'] });
    act(() => byTestId('ledger-filter-status-blocked').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...NONE,
      statuses: ['BLOCKED'],
    });
    act(() => byTestId('ledger-filter-owner-you').click());
    expect(onChange).toHaveBeenLastCalledWith({ ...NONE, owner: 'you' });

    act(() =>
      root.render(
        <LedgerFilterMenu
          filters={{ ...NONE, owner: 'you' }}
          onChange={onChange}
        />,
      ),
    );
    expect(byTestId('ledger-filter-active-dot')).toBeDefined();
  });

  it('opens at its first section, even when a later option is checked', () => {
    act(() =>
      root.render(<LedgerFilterMenu filters={NONE} onChange={jest.fn()} />),
    );
    act(() => byTestId('ledger-filter-trigger').click());

    // "Anyone" is checked, but focus (and the scroll it brings) starts at
    // the top, so every section reads in order.
    expect(document.activeElement).toBe(byTestId('ledger-filter-type-task'));
  });
});
