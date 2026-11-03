/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { PAGE_COLUMN_WIDTH_CLASS, PageColumn } from '../PageColumn';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function rendered(node: ReactNode): Element | null {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const element = container.firstElementChild?.cloneNode(true);
  act(() => root.unmount());
  container.remove();
  return element instanceof Element ? element : null;
}

function classesOf(node: ReactNode): string[] {
  return (rendered(node)?.getAttribute('class') ?? '').split(' ');
}

describe('PageColumn', () => {
  it('centers one width with the shared gutter and the page gap', () => {
    expect(
      classesOf(
        <PageColumn width="content">
          <section />
        </PageColumn>,
      ),
    ).toEqual([
      'mx-auto',
      'flex',
      'w-full',
      'min-w-0',
      'flex-col',
      'gap-8',
      'px-4',
      'sm:px-8',
      'max-w-176',
    ]);
  });

  it('holds only the decided widths', () => {
    expect(PAGE_COLUMN_WIDTH_CLASS).toEqual({ content: 'max-w-176' });
  });

  it('renders the landmark and appends placement', () => {
    const column = rendered(
      <PageColumn
        as="main"
        width="content"
        className="relative"
        data-testid="column"
      />,
    );
    expect(column?.tagName).toBe('MAIN');
    expect(column?.getAttribute('data-testid')).toBe('column');
    expect(column?.getAttribute('class')).toMatch(/max-w-176 relative$/);
  });
});
