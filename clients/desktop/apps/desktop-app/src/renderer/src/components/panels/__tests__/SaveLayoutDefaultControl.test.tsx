/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see
 * ModelPicker.test.tsx, WorktreeTopBar.test.tsx);
 * @testing-library/react is not installed. The root mounts on
 * document.body so the control's portal (also rendered into
 * document.body via createPortal) is covered by React event delegation.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SaveLayoutDefaultControl } from '../SaveLayoutDefaultControl';

const saveMock: (key: string) => Promise<boolean> = jest
  .fn()
  .mockResolvedValue(true);
const addToastMock = jest.fn();

jest.mock('@/lib/panels/default-layout-save', () => ({
  saveCurrentLayoutAsDefault: (key: string): Promise<boolean> => saveMock(key),
}));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof addToastMock } => ({
      addToast: addToastMock,
    }),
  },
}));

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

function trigger(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="worktree-top-save-layout-default"]',
  );
  if (!el) throw new Error('trigger button not found');
  return el;
}

function menuItem(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="save-layout-default-item"]',
  );
}

function openMenu(): void {
  act(() => {
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('SaveLayoutDefaultControl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the dropdown and saves the current layout as default', async () => {
    render(
      createElement(SaveLayoutDefaultControl, {
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );

    openMenu();

    const item = menuItem();
    if (!item) throw new Error('menu item not found');

    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveMock).toHaveBeenCalledWith('proj/wt');
    expect(addToastMock).toHaveBeenCalledWith(
      'Saved current layout as the default for new worktrees',
      'success',
    );
    // Menu closes after selecting.
    expect(menuItem()).toBeNull();
  });

  it('uses the compact shared surface and returns focus on immediate dismissals', () => {
    render(
      createElement(SaveLayoutDefaultControl, {
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );
    openMenu();
    const menu = document.querySelector<HTMLElement>(
      '[data-testid="save-layout-default-menu"]',
    );
    const item = menuItem();

    expect(menu?.className).toContain('rounded-lg');
    expect(menu?.className).toContain('bg-quaternary');
    expect(menu?.className).toContain('p-1');
    expect(menu?.className).toContain('shadow-xl');
    expect(menu?.className).toContain('w-max');
    expect(item?.className).toContain('h-8');
    expect(item?.className).toContain('rounded-md');
    expect(item?.className).toContain('text-xs');
    // The row leads with its icon in the standard icon slot; the label span
    // follows.
    const [iconSlot, label] = Array.from(item?.children ?? []);
    expect(iconSlot?.getAttribute('aria-hidden')).toBe('true');
    expect(iconSlot?.querySelector('svg')).toBeInstanceOf(Element);
    expect(label?.className).toContain('whitespace-nowrap');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(menuItem()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    openMenu();
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(menuItem()).toBeNull();
  });
});
