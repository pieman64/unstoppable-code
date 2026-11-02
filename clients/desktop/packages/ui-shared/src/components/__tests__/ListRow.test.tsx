/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { ListRow } from '../ListRow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ListRow', () => {
  it('uses the sidebar row geometry: 32px, row radius, subtle hover', () => {
    const html = renderToStaticMarkup(<ListRow>Deploy preview</ListRow>);

    expect(html).toContain('type="button"');
    expect(html).toContain('h-8');
    expect(html).toContain('w-full');
    expect(html).toContain('rounded-row');
    expect(html).toContain('text-left');
    expect(html).toContain('hover:bg-subtle');
    expect(html).not.toContain('bg-muted');
  });

  it('grows to hold a description under the label', () => {
    const html = renderToStaticMarkup(
      <ListRow description="Issues, pull requests and checks">GitHub</ListRow>,
    );

    expect(html).toContain('min-h-8');
    expect(html).not.toMatch(/(?<![\w-])h-8\b/);
    expect(html).toContain('GitHub');
    expect(html).toContain('Issues, pull requests and checks');
    expect(html).toContain('fg-secondary');
  });

  it('marks the selected row with the selected fill', () => {
    const html = renderToStaticMarkup(<ListRow selected>Run tests</ListRow>);

    expect(html).toContain('bg-muted');
    expect(html).not.toContain('hover:bg-subtle');
  });

  it('greys every part of a disabled row, not only the label', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <ListRow
          disabled
          icon={<svg data-icon="" />}
          description="Needs a key"
          trailing="Off"
        >
          OpenAI
        </ListRow>,
      );
    });

    const row = container.querySelector('button');
    expect(row?.disabled).toBe(true);
    expect(row?.className).toContain('disabled:fg-disabled');
    // It stays the click target (no pass-through to a row behind it) and
    // drops the hover fill instead.
    expect(row?.className).not.toContain('pointer-events-none');
    expect(row?.className).toContain('disabled:bg-transparent');
    expect(row?.className).toContain('disabled:cursor-not-allowed');
    const icon = container.querySelector('[data-icon]')?.parentElement;
    const description = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Needs a key',
    );
    const trailing = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Off',
    );
    for (const part of [icon, description, trailing]) {
      expect(part?.className).toContain('group-disabled/list-row:fg-disabled');
    }

    act(() => root.unmount());
  });

  it('renders the leading icon and trailing content', () => {
    const html = renderToStaticMarkup(
      <ListRow icon={<svg data-icon="" />} trailing="2m ago">
        Lint
      </ListRow>,
    );

    expect(html).toContain('data-icon');
    expect(html).toContain('2m ago');
  });

  it('forwards native props and refs', () => {
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const ref = createRef<HTMLButtonElement>();
    const onClick = jest.fn();

    act(() => {
      root.render(
        <ListRow
          ref={ref}
          onClick={onClick}
          data-testid="row"
          aria-current="page"
        >
          Pipelines
        </ListRow>,
      );
    });
    act(() => ref.current?.click());

    expect(ref.current).toBe(container.querySelector('button'));
    expect(ref.current?.dataset.testid).toBe('row');
    expect(ref.current?.getAttribute('aria-current')).toBe('page');
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
