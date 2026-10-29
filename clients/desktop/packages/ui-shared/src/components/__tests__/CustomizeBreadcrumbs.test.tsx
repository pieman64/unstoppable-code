/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CustomizeBreadcrumbs } from '../CustomizeBreadcrumbs';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('CustomizeBreadcrumbs', () => {
  let container: HTMLElement;
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

  it('renders buttons, router links, chevrons and the current page', () => {
    const onRoot = jest.fn();
    act(() =>
      root.render(
        <CustomizeBreadcrumbs
          testId="crumbs"
          items={[
            {
              key: 'root',
              label: 'Customize',
              testId: 'root',
              onSelect: onRoot,
            },
            {
              key: 'type',
              label: 'Skills',
              testId: 'type',
              href: '/portal/plugins/skills',
              entryKind: 'skill',
            },
            { key: 'current', label: 'Review Checklist', testId: 'current' },
          ]}
          renderLink={({ href, className, testId, entryKind, children }) => (
            <a
              href={href}
              className={className}
              data-testid={testId}
              data-entry-kind={entryKind}
            >
              {children}
            </a>
          )}
        />,
      ),
    );
    const nav = container.querySelector('[data-testid="crumbs"]');
    expect(nav?.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(nav?.querySelectorAll('li[aria-hidden="true"] svg')).toHaveLength(2);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="root"]')
        ?.click(),
    );
    expect(onRoot).toHaveBeenCalledTimes(1);
    const type = container.querySelector('[data-testid="type"]');
    expect(type?.tagName).toBe('A');
    expect(type?.getAttribute('href')).toBe('/portal/plugins/skills');
    expect(type?.getAttribute('data-entry-kind')).toBe('skill');
    const current = container.querySelector('[data-testid="current"]');
    expect(current?.getAttribute('aria-current')).toBe('page');
    expect(current?.textContent).toBe('Review Checklist');
  });

  it('renders a crumb with no action as plain text', () => {
    act(() =>
      root.render(
        <CustomizeBreadcrumbs
          items={[
            { key: 'type', label: 'Skills', testId: 'type' },
            { key: 'current', label: 'Edit' },
          ]}
        />,
      ),
    );
    const type = container.querySelector('[data-testid="type"]');
    expect(type?.tagName).toBe('SPAN');
    expect(type?.getAttribute('aria-current')).toBeNull();
  });
});
