/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { BusyLabel } from '../BusyLabel';

function render(busy: boolean): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <BusyLabel busy={busy}>Load more</BusyLabel>,
  );
  return container;
}

function reservedLabels(container: HTMLElement): readonly (string | null)[] {
  return Array.from(container.querySelectorAll('[data-reserved-label]')).map(
    (element) => element.getAttribute('data-reserved-label'),
  );
}

describe('BusyLabel under the text loading style', () => {
  it('holds room for the busy text while resting, so the control never resizes', () => {
    const container = render(false);
    expect(container.textContent).toBe('Load more');
    expect(reservedLabels(container)).toEqual(['Loading…']);
  });

  it('shows the busy text and holds the resting label’s room while busy', () => {
    const container = render(true);
    expect(container.textContent).toBe('Loading…');
    expect(reservedLabels(container)).toEqual(['Load more']);
  });
});
