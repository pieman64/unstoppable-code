/** @jest-environment jsdom */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { OrgProjectRow } from '../OrgProjectRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const project: OrgProjectSummary = {
  id: 'p1',
  organizationId: 'org',
  name: 'Canopy',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'private',
  memberOwned: true,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'canopy',
    providerRepoId: '1',
    defaultBranch: 'main',
    verification: 'VERIFIED',
    visibility: 'PRIVATE',
    description: 'The app',
    updatedAt: '2026-10-18T00:00:00.000Z',
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: false,
  preference: 'FOLLOW_DEFAULTS',
  listed: false,
  capabilities: { use: true, administer: true, manageCloud: false },
  instance: null,
};

describe('OrgProjectRow', () => {
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

  function render(
    props: Partial<ComponentProps<typeof OrgProjectRow>> = {},
  ): HTMLElement {
    act(() => {
      root.render(
        <OrgProjectRow project={project} testIdPrefix="prefix" {...props} />,
      );
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="prefix-row-p1"]',
    );
    if (row === null) throw new Error('row not rendered');
    return row;
  }

  it('prefixes every test id', () => {
    render();
    for (const suffix of [
      'row',
      'name',
      'visibility',
      'private',
      'description',
      'updated',
    ])
      expect(
        container.querySelector(`[data-testid="prefix-${suffix}-p1"]`),
      ).not.toBeNull();
  });

  it('has no role without onActivate', () => {
    const row = render();
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
  });

  it('activates on click, Enter and Space', () => {
    const onActivate = jest.fn();
    const row = render({ onActivate });
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('aria-label')).toBe('canopy');
    act(() => row.click());
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('does not activate from a control inside actions', () => {
    const onActivate = jest.fn();
    const onAction = jest.fn();
    render({
      onActivate,
      actions: (
        <button type="button" data-testid="action" onClick={onAction}>
          Set up
        </button>
      ),
    });
    const action = container.querySelector<HTMLElement>(
      '[data-testid="action"]',
    );
    act(() => action?.click());
    act(() => {
      action?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not activate while disabled', () => {
    const onActivate = jest.fn();
    const row = render({ onActivate, disabled: true });
    act(() => row.click());
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('replaces the description line and leads the updated line with status', () => {
    render({ description: 'acme/canopy', status: 'Archived' });
    expect(
      container.querySelector('[data-testid="prefix-description-p1"]')
        ?.textContent,
    ).toBe('acme/canopy');
    expect(container.textContent).toContain('Archived · Updated');
  });

  it('keeps one cell per list column on the grid, even when empty', () => {
    const flex = render();
    expect(flex.children).toHaveLength(1);
    const grid = render({ columns: true });
    expect(grid.className).toContain('grid-cols-subgrid');
    expect(grid.children).toHaveLength(3);
  });
});
