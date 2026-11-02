/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { LedgerThreadListSkeleton } from '../LedgerThreadListSkeleton';

function render(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  const region = host.querySelector<HTMLElement>(
    '[data-testid="ledger-thread-list-skeleton"]',
  );
  if (!(region instanceof HTMLElement)) throw new Error('no skeleton');
  return region;
}

describe('LedgerThreadListSkeleton', () => {
  it('announces loading once, with no visible text', () => {
    const region = render(
      renderToStaticMarkup(<LedgerThreadListSkeleton density="panel" />),
    );
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('Loading entries');
    expect(region.querySelector('.sr-only')?.textContent).toBe(
      'Loading entries',
    );
  });

  it('draws panel rows on the entry row height, avatar and dividers', () => {
    const region = render(
      renderToStaticMarkup(<LedgerThreadListSkeleton density="panel" />),
    );
    const rows = Array.from(region.children).filter(
      (child) => !child.classList.contains('sr-only'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.classList.contains('py-3')).toBe(true);
    expect(rows[0]?.classList.contains('border-b')).toBe(true);
    expect(rows.at(-1)?.classList.contains('border-b')).toBe(false);
    expect(rows[0]?.firstElementChild?.classList.contains('size-6')).toBe(true);
    // The actions line keeps its 28px but draws nothing.
    const actions = rows[0]?.querySelector(
      '[data-testid="ledger-thread-list-skeleton-actions"]',
    );
    expect(actions?.classList.contains('h-7')).toBe(true);
    expect(actions?.childElementCount).toBe(0);
    // Every block pulses, except under reduced motion.
    for (const block of Array.from(
      region.querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
    )) {
      expect(block.classList.contains('animate-pulse')).toBe(true);
      expect(block.classList.contains('motion-reduce:animate-none')).toBe(true);
    }
  });

  it('draws page rows at the page density', () => {
    const region = render(
      renderToStaticMarkup(
        <LedgerThreadListSkeleton density="page" rows={2} />,
      ),
    );
    const rows = Array.from(region.children).filter(
      (child) => !child.classList.contains('sr-only'),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains('py-4')).toBe(true);
    expect(rows[0]?.firstElementChild?.classList.contains('size-8')).toBe(true);
  });
});
