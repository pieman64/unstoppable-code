/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CollectionReadDetail,
  type CollectionReadDetailProps,
} from '../CollectionReadDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function mount(element: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

const collection: CollectionReadDetailProps['collection'] = {
  name: 'Release helpers',
  description: 'Everything needed to ship.',
  memberRefs: [
    { kind: 'skill', sourceId: 'builtin:core', skillName: 'review' },
    { kind: 'plugin', marketplaceId: 'official', pluginName: 'deploy' },
    { kind: 'mcp', serverId: 'github', configId: 'primary' },
    { kind: 'skill', sourceId: 'custom:app', skillName: 'missing' },
  ],
};

const resolvedMembers: CollectionReadDetailProps['resolvedMembers'] = [
  {
    ref: collection.memberRefs[0],
    entryKey: 'skill:builtin:core/review',
    name: 'Review',
    description: 'Review changes',
    source: 'Built in',
  },
  {
    ref: collection.memberRefs[1],
    entryKey: 'plugin:official/deploy',
    name: 'Deploy',
    description: 'Deploy safely',
    source: 'Official',
  },
  {
    ref: collection.memberRefs[2],
    entryKey: 'mcp:github/primary',
    name: 'GitHub',
    description: 'Repository tools',
    source: 'Local',
  },
];

describe('CollectionReadDetail', () => {
  it('mounts the same host-supplied status section beside collection details', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={collection}
        resolvedMembers={resolvedMembers}
        statusSection={<div data-testid="collection-status">Status</div>}
      />,
    );
    expect(
      container.querySelector('[data-testid="collection-status"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });
  it('groups resolved members and renders unresolved references', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={collection}
        resolvedMembers={resolvedMembers}
      />,
    );

    expect(container.textContent).toContain('Skills (2)');
    expect(container.textContent).toContain('Plugins (1)');
    expect(container.textContent).toContain('MCP servers (1)');
    expect(container.textContent).toContain('Review');
    expect(container.textContent).toContain('Missing skill: missing');
    expect(
      container.querySelector('[data-testid="collection-read-unresolved"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('renders the description as Markdown with a list', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={{
          ...collection,
          description: 'Ship safely.\n\n1. Review\n2. Deploy',
        }}
        resolvedMembers={resolvedMembers}
      />,
    );
    const description = container.querySelector(
      '[data-testid="share-description"]',
    );
    expect(description?.querySelector('p')?.textContent).toBe('Ship safely.');
    expect(
      Array.from(
        description?.querySelectorAll('ol > li') ?? [],
        (item) => item.textContent,
      ),
    ).toEqual(['Review', 'Deploy']);
    act(() => root.unmount());
  });

  it('keeps the empty description state', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={{ ...collection, description: '' }}
        resolvedMembers={resolvedMembers}
      />,
    );
    expect(
      container.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
    expect(container.textContent).toContain('No description.');
    act(() => root.unmount());
  });

  it('shows the empty state for a description with no visible text', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={{ ...collection, description: '---' }}
        resolvedMembers={resolvedMembers}
      />,
    );
    expect(
      container.querySelector('[data-testid="share-description"]'),
    ).toBeNull();
    expect(container.textContent).toContain('No description.');
    act(() => root.unmount());
  });

  it('opens a resolved member through the host callback', () => {
    const onOpenEntry = jest.fn();
    const { container, root } = mount(
      <CollectionReadDetail
        collection={collection}
        resolvedMembers={resolvedMembers}
        onOpenEntry={onOpenEntry}
      />,
    );

    act(() => {
      container
        .querySelector('[data-entry-key="plugin:official/deploy"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenEntry).toHaveBeenCalledWith(resolvedMembers[1]);
    act(() => root.unmount());
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])(
    'shows only available actions (edit=%s, import=%s, add=%s)',
    (hasEdit, hasImport, hasAdd) => {
      const onEdit = jest.fn();
      const onImport = jest.fn();
      const onAdd = jest.fn();
      const { container, root } = mount(
        <CollectionReadDetail
          collection={collection}
          resolvedMembers={resolvedMembers}
          onEdit={hasEdit ? onEdit : undefined}
          onImport={hasImport ? onImport : undefined}
          onAdd={hasAdd ? onAdd : undefined}
        />,
      );
      const actions = [
        ['edit', hasEdit, onEdit],
        ['import', hasImport, onImport],
        ['add', hasAdd, onAdd],
      ] as const;
      for (const [action, visible, callback] of actions) {
        const button = container.querySelector(
          `[data-testid="collection-read-action-${action}"]`,
        );
        expect(button === null).toBe(!visible);
        if (visible) {
          act(() => {
            button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          });
          expect(callback).toHaveBeenCalledTimes(1);
        }
      }
      act(() => root.unmount());
    },
  );

  it('renders names and records the description and labels in session replay', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={collection}
        resolvedMembers={resolvedMembers}
      />,
    );
    const leaf = (text: string): Element | undefined =>
      Array.from(container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    expect(
      container
        .querySelector('[data-testid="share-description"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();
    for (const text of [
      'Release helpers',
      'Review',
      'Review changes',
      'Built in',
    ]) {
      expect(leaf(text)).toBeDefined();
    }
    // Static labels stay recorded.
    for (const text of ['Name', 'Description', 'Skills (2)']) {
      const element = leaf(text);
      expect(element).toBeDefined();
      expect(element?.closest('.ph-no-capture')).toBeNull();
    }
    act(() => root.unmount());
  });

  it('records the empty description copy', () => {
    const { container, root } = mount(
      <CollectionReadDetail
        collection={{ ...collection, description: '' }}
        resolvedMembers={resolvedMembers}
      />,
    );
    const empty = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'No description.',
    );
    expect(empty?.closest('.ph-no-capture')).toBeNull();
    expect(empty).toBeDefined();
    act(() => root.unmount());
  });
});
