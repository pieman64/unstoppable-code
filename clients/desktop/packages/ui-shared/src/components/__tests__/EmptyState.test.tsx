/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { EmptyState } from '../StatusBlocks';

function render(element: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('EmptyState', () => {
  it('renders the title and subtitle', () => {
    const container = render(
      <EmptyState
        testId="empty"
        title="No notifications"
        subtitle="Recent messages will appear here."
      />,
    );
    expect(container.querySelector('h3')?.textContent).toBe('No notifications');
    expect(container.querySelector('p')?.textContent).toBe(
      'Recent messages will appear here.',
    );
  });
});
