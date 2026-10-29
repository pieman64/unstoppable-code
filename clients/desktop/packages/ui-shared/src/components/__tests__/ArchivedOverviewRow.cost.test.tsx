/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArchivedOverviewRow } from '../ArchivedOverviewRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ArchivedOverviewRow observed cost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('places the accessible observed cost before host-provided trailing details', () => {
    act(() =>
      root.render(
        <ArchivedOverviewRow
          state="archived"
          title="Old chat"
          stateTooltip="Archived"
          observedCostLabel="$21.66"
          trailing={<span data-testid="row-size">12.4 MB</span>}
          date="Oct 6"
          actions={null}
        />,
      ),
    );

    const cost = container.querySelector<HTMLElement>(
      '[data-testid="archived-overview-row-cost"]',
    );
    expect(cost?.textContent).toBe('Observed cost $21.66');
    expect(cost?.className).toContain('tabular-nums');
    const rowText = container.textContent ?? '';
    expect(rowText.indexOf('Observed cost $21.66')).toBeLessThan(
      rowText.indexOf('12.4 MB'),
    );
  });

  it('renders no cost element when observed cost is absent', () => {
    act(() =>
      root.render(
        <ArchivedOverviewRow
          state="archived"
          title="Old chat"
          stateTooltip="Archived"
          date="Oct 6"
          actions={null}
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="archived-overview-row-cost"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('$0.00');
  });
});
