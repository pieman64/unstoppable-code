/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArchivedRowActionsMenu } from '../ArchivedRowActionsMenu';
import { pushMenuOpenBodyFlag } from '../../lib/menu-open-body-flag';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;
const onRestore = jest.fn();
const onToggleState = jest.fn();
const onDeletePermanently = jest.fn();

function render(props: {
  archived: boolean;
  busy?: boolean;
  restoreBlockedReason?: string;
}): void {
  act(() =>
    root.render(
      <ArchivedRowActionsMenu
        itemName="Archived task"
        testIdPrefix="row"
        onRestore={onRestore}
        onToggleState={onToggleState}
        onDeletePermanently={onDeletePermanently}
        {...props}
      />,
    ),
  );
}
function byTestId(id: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}`);
  return node;
}
function buttonByTestId(id: string): HTMLButtonElement {
  const node = byTestId(id);
  if (!(node instanceof HTMLButtonElement))
    throw new Error(`${id} not a button`);
  return node;
}
function menuButtons(): HTMLButtonElement[] {
  return Array.from(
    byTestId('row-menu').querySelectorAll<HTMLButtonElement>('button'),
  );
}
function openMenu(): void {
  act(() => byTestId('row-actions').click());
}

beforeEach(() => {
  container = document.createElement('div');
  container.className = 'group';
  document.body.appendChild(container);
  root = createRoot(container);
  onRestore.mockReset();
  onToggleState.mockReset();
  onDeletePermanently.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('offers Restore, then Archive and Permanent in their own last group, for a Deleted item', () => {
  render({ archived: false });
  expect(document.querySelector('[data-testid="row-menu"]')).toBeNull();
  openMenu();
  const menu = byTestId('row-menu');
  expect(menuButtons().map((button) => button.textContent?.trim())).toEqual([
    'Restore',
    'Archive',
    'Permanent',
  ]);
  const separators = menu.querySelectorAll('[role="separator"]');
  expect(separators).toHaveLength(1);
  const separator = separators[0];
  // The removal rows close the menu in their own group.
  expect(
    separator.compareDocumentPosition(byTestId('row-restore')) &
      Node.DOCUMENT_POSITION_PRECEDING,
  ).toBeTruthy();
  expect(
    separator.compareDocumentPosition(byTestId('row-state')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // The action-menu rows: small text, tertiary icons on plain rows, while
  // Permanent keeps its destructive ink.
  expect(byTestId('row-restore').className).toContain('text-xs');
  expect(
    byTestId('row-state').querySelector('span[aria-hidden="true"]')?.className,
  ).toContain('fg-tertiary');
  expect(
    byTestId('row-delete').querySelector('span[aria-hidden="true"]')?.className,
  ).not.toContain('fg-tertiary');
  expect(byTestId('row-state').className).not.toContain('fg-destructive');
  expect(byTestId('row-delete').className).toContain('fg-destructive');
  act(() => byTestId('row-state').click());
  expect(onToggleState).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="row-menu"]')).toBeNull();
});

it('offers Delete for an Archived item and only announces permanent deletion', () => {
  render({ archived: true });
  openMenu();
  expect(byTestId('row-state').textContent?.trim()).toBe('Delete');
  act(() => byTestId('row-delete').click());
  expect(onDeletePermanently).toHaveBeenCalledTimes(1);
  act(() => byTestId('row-actions').click());
  act(() => byTestId('row-restore').click());
  expect(onRestore).toHaveBeenCalledTimes(1);
});

it('shows the blocked-restore reason inside the menu and describes the item with it', () => {
  render({ archived: true, restoreBlockedReason: 'Restore the project first' });
  openMenu();
  const restore = buttonByTestId('row-restore');
  expect(restore.disabled).toBe(true);
  const reason = byTestId('row-restore-reason');
  expect(reason.textContent).toBe('Restore the project first');
  expect(restore.getAttribute('aria-describedby')).toBe(reason.id);
  // Keyboard users land on the first enabled item; the reason stays visible.
  expect(document.activeElement).toBe(byTestId('row-state'));
  act(() => restore.click());
  expect(onRestore).not.toHaveBeenCalled();
});

it('opens on pointerdown while another menu is open so switching rows takes one press', () => {
  render({ archived: false });
  const release = pushMenuOpenBodyFlag(document);
  act(() => {
    byTestId('row-actions').dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true }),
    );
  });
  release();
  expect(document.querySelector('[data-testid="row-menu"]')).not.toBeNull();
});

it('gives the trigger a 44px touch target and disables actions while busy', () => {
  render({ archived: false, busy: true });
  const trigger = byTestId('row-actions');
  expect(trigger.className).toContain('pointer-coarse:h-11');
  expect(trigger.className).toContain('pointer-coarse:w-11');
  expect(trigger.className).toContain('@min-[36rem]/archived-list:opacity-100');
  openMenu();
  expect(menuButtons().every((button) => button.disabled)).toBe(true);
});
