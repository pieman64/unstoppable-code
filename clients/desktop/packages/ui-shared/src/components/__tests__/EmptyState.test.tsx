/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { FolderIcon } from '../../icons/AppIcons';
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

  // docs/design/icons.md#sizes: empty-state art is 32px or 40px, owned here.
  it.each([
    [undefined, '32px'],
    [32, '32px'],
    [40, '40px'],
  ] as const)('draws its art at artSize %s as %s', (artSize, px) => {
    const svg = render(
      <EmptyState title="No files" art={FolderIcon} artSize={artSize} />,
    ).querySelector('svg');
    expect(svg?.getAttribute('width')).toBe(px);
    expect(svg?.getAttribute('height')).toBe(px);
    expect(svg?.style.width).toBe(px);
    expect(svg?.dataset.iconSize).toBe('exact');
  });
});
