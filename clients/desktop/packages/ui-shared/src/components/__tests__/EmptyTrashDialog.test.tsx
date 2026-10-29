/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EmptyTrashDialog,
  type EmptyTrashDialogProps,
} from '../EmptyTrashDialog';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
it.each([1, 2])('names the exact permanent deletion count (%i)', (count) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <EmptyTrashDialog
        items={Array.from({ length: count }, (_, i) => ({
          id: String(i),
          name: `Item ${i}`,
        }))}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    ),
  );
  expect(document.body.textContent).toContain(
    `Delete ${count} ${count === 1 ? 'item' : 'items'} permanently`,
  );
  act(() => root.unmount());
  container.remove();
});

it.each([
  {
    name: 'workspace only',
    items: [{ id: 'workspace:ws-1', name: 'Project one' }],
  },
  {
    name: 'mixed workspace and chat',
    items: [
      { id: 'workspace:ws-1', name: 'Project one' },
      { id: 'chat:c1', name: 'Deleted chat' },
    ],
  },
])(
  'warns that $name deletion includes archived children and retained history',
  ({ items }) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <EmptyTrashDialog
          items={items}
          includesWorkspaces
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />,
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      'Selected workspaces include all their chats and retained history, including archived chats.',
    );
    expect(dialog?.textContent).toContain(
      'Archived items outside those workspaces are not affected.',
    );
    expect(dialog?.textContent).not.toContain(
      'Archived items are not affected.',
    );
    act(() => root.unmount());
    container.remove();
  },
);

it('preserves the archived-items promise for chat-only trash', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <EmptyTrashDialog
        items={[{ id: 'chat:c1', name: 'Deleted chat' }]}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    ),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Archived items are not affected.',
  );
  act(() => root.unmount());
  container.remove();
});

const ITEM_TONES: readonly EmptyTrashDialogProps['itemTone'][] = [
  undefined,
  'quiet',
];

it.each(ITEM_TONES)(
  'renders host-provided names, trailing metadata and summary with tone %s',
  (itemTone) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    act(() =>
      root.render(
        <EmptyTrashDialog
          items={[
            {
              id: 'chat:c1',
              name: 'Release preparation',
              trailing: <span data-testid="host-size">2 KB</span>,
            },
          ]}
          itemTone={itemTone}
          summary={<div data-testid="host-summary">Frees at least 1 KB</div>}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      ),
    );
    const list = document.querySelector(
      '[data-testid="archived-overview-empty-trash-list"]',
    );
    const item = list?.querySelector(
      '[data-testid="archived-overview-empty-trash-item-chat:c1"]',
    );
    expect(item?.textContent).toBe('Release preparation2 KB');
    expect(item?.className.split(' ')).toContain(
      itemTone === 'quiet' ? 'fg-primary/80' : 'fg-primary',
    );
    expect(item?.querySelector('[data-testid="host-size"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="host-summary"]')?.textContent,
    ).toBe('Frees at least 1 KB');
    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="archived-overview-empty-trash-cancel"]',
    );
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="archived-overview-empty-trash-confirm"]',
    );
    act(() => confirm?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  },
);

it('keeps busy actions disabled and prevents empty confirmation', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  act(() =>
    root.render(
      <EmptyTrashDialog
        items={[{ id: 'chat:c1', name: 'Deleted chat' }]}
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    ),
  );
  const cancel = document.querySelector<HTMLButtonElement>(
    '[data-testid="archived-overview-empty-trash-cancel"]',
  );
  const confirm = document.querySelector<HTMLButtonElement>(
    '[data-testid="archived-overview-empty-trash-confirm"]',
  );
  expect(cancel?.disabled).toBe(true);
  expect(confirm?.disabled).toBe(true);
  expect(confirm?.textContent).toBe('Deleting…');
  act(() => {
    cancel?.click();
    confirm?.click();
  });
  expect(onCancel).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
  act(() =>
    root.render(
      <EmptyTrashDialog items={[]} onCancel={onCancel} onConfirm={onConfirm} />,
    ),
  );
  expect(confirm?.disabled).toBe(true);
  expect(cancel?.disabled).toBe(false);
  act(() => root.unmount());
  container.remove();
});

it('masks private item names while preserving sizes and confirmation copy', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <EmptyTrashDialog
        items={[
          {
            id: 'private-item',
            name: 'Private release plan',
            trailing: <span data-testid="private-size">2 KB</span>,
          },
        ]}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    ),
  );
  const row = document.querySelector(
    '[data-testid="archived-overview-empty-trash-item-private-item"]',
  );
  expect(row?.querySelector('.ph-mask')?.textContent).toBe(
    'Private release plan',
  );
  expect(row?.classList.contains('ph-mask')).toBe(false);
  expect(
    row?.querySelector('[data-testid="private-size"]')?.closest('.ph-mask'),
  ).toBeNull();
  expect(
    document
      .querySelector('[data-testid="archived-overview-empty-trash-confirm"]')
      ?.closest('.ph-mask'),
  ).toBeNull();
  act(() => root.unmount());
  container.remove();
});
