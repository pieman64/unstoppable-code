/**
 * @jest-environment jsdom
 */
import { renderToString } from 'react-dom/server';
import { SubTabNav } from '../SubTabNav';

type Variant = 'segmented' | 'underline';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'billing', label: 'Billing', attention: true },
] as const;

function renderNav(variant?: Variant): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <SubTabNav
      tabs={TABS}
      activeTab="general"
      onSelect={(): void => {}}
      testIdPrefix="memory-views"
      ariaLabel="Organization settings"
      variant={variant}
    />,
  );
  return container;
}

function classesOf(container: HTMLElement, testId: string): string[] {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`No [data-testid="${testId}"]`);
  return (el.getAttribute('class') ?? '').split(/\s+/);
}

/** The scroll frame is the strip wrapper that carries the border. */
function frameClasses(container: HTMLElement): string[] {
  const nav = container.querySelector('[data-testid="memory-views-tabs"]');
  const classes: string[] = [];
  for (let el = nav?.parentElement; el; el = el.parentElement) {
    classes.push(...(el.getAttribute('class') ?? '').split(/\s+/));
  }
  return classes;
}

describe('SubTabNav', () => {
  it('stays a segmented pill control by default', () => {
    const container = renderNav();

    expect(frameClasses(container)).toEqual(
      expect.arrayContaining(['rounded-md', 'border', 'p-0.5']),
    );
    expect(classesOf(container, 'memory-views-tab-general')).toEqual(
      expect.arrayContaining(['bg-accent', 'fg-emphasis']),
    );
    expect(classesOf(container, 'memory-views-tab-billing')).not.toContain(
      'border-b-2',
    );
  });

  it('renders an underline strip for a page-level view switcher', () => {
    const container = renderNav('underline');

    const frame = frameClasses(container);
    expect(frame).toContain('border-b');
    expect(frame).not.toContain('rounded-md');
    expect(frame).not.toContain('p-0.5');

    const active = classesOf(container, 'memory-views-tab-general');
    expect(active).toEqual(
      expect.arrayContaining([
        '-mb-px',
        'border-b-2',
        'tab-accent-line',
        'fg-primary',
      ]),
    );
    expect(active).not.toContain('bg-accent');
    // The unlayered base `border-color` rule overrides `tab-accent-line`
    // (CAN-2734), so the selected bar is a pseudo-element the rule can't reach.
    expect(active).toEqual(
      expect.arrayContaining([
        'relative',
        'after:absolute',
        'after:inset-x-0',
        'after:-bottom-0.5',
        'after:h-0.5',
        'after:bg-line-accent',
      ]),
    );

    const inactive = classesOf(container, 'memory-views-tab-billing');
    expect(inactive).toEqual(
      expect.arrayContaining([
        '-mb-px',
        'border-b-2',
        'border-transparent',
        'fg-secondary',
      ]),
    );
    expect(inactive).not.toContain('after:bg-line-accent');
  });

  it.each<[Variant]>([['segmented'], ['underline']])(
    'keeps the toggle semantics and test ids in the %s variant',
    (variant) => {
      const container = renderNav(variant);

      const nav = container.querySelector('[data-testid="memory-views-tabs"]');
      expect(nav?.getAttribute('aria-label')).toBe('Organization settings');
      const general = container.querySelector(
        '[data-testid="memory-views-tab-general"]',
      );
      const billing = container.querySelector(
        '[data-testid="memory-views-tab-billing"]',
      );
      expect(general?.tagName).toBe('BUTTON');
      expect(general?.getAttribute('aria-pressed')).toBe('true');
      expect(billing?.getAttribute('aria-pressed')).toBe('false');
      expect(
        billing
          ?.querySelector(
            '[data-testid="memory-views-tab-billing-attention-dot"]',
          )
          ?.getAttribute('aria-label'),
      ).toBe('Billing needs attention');
    },
  );
});
