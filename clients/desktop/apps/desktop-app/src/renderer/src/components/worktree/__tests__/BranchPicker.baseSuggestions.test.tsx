/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BranchEntry } from '@canopy/desktop-shared/types';
import { BranchPicker } from '../BranchPicker';

function branch(name: string): BranchEntry {
  return {
    name,
    isRemote: false,
    isCurrent: name === 'main',
    isUsedByWorktree: false,
    hasLocalRef: true,
    hasRemoteRef: false,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listBranches: jest.fn(() =>
        Promise.resolve({
          branches: [branch('main'), branch('develop'), branch('release')],
          defaultBranch: 'main',
        }),
      ),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function openCreateView(onClose: () => void): Promise<HTMLInputElement> {
  await act(async () => {
    root.render(
      <BranchPicker
        projectId="proj-1"
        worktreeId="wt-1"
        currentBranch="main"
        onBranchSwitched={jest.fn()}
        onBranchCreated={jest.fn()}
        onClose={onClose}
      />,
    );
    await Promise.resolve();
  });
  const newBranch = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes('New branch'),
  );
  act(() => newBranch?.click());
  const input = Array.from(
    container.querySelectorAll<HTMLInputElement>('input'),
  ).find((field) => field.value === 'main');
  if (!input) throw new Error('base branch field missing');
  return input;
}

function suggestions(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[role="listbox"][aria-label="Base branches"]',
  );
}

function realPress(target: Element): void {
  act(() => {
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true }),
      );
    }
  });
}

function buttonNamed(label: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`${label} button missing`);
  return button;
}

describe('BranchPicker base branch suggestions', () => {
  it('lists matching branches in the shared menu layer and picks one', async () => {
    const input = await openCreateView(jest.fn());
    act(() => input.focus());

    const list = suggestions();
    expect(list).not.toBeNull();
    // Portaled out of the picker, so a clipping parent cannot cut it off.
    expect(container.contains(list)).toBe(false);
    expect(list?.classList.contains('canopy-floating-menu')).toBe(true);
    const main = Array.from(
      list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    ).find((option) => option.textContent?.includes('main'));
    expect(main?.getAttribute('aria-selected')).toBe('true');

    // Typing filters the suggestions.
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'dev');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const develop = Array.from(
      suggestions()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    ).find((option) => option.textContent?.includes('develop'));
    expect(develop).toBeDefined();
    act(() => {
      develop?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
    });
    expect(input.value).toBe('develop');
    expect(suggestions()).toBeNull();
    // Picking keeps focus in the field.
    expect(document.activeElement).toBe(input);
  });

  it('runs Cancel on the first click while the suggestions are open', async () => {
    const input = await openCreateView(jest.fn());
    act(() => input.focus());
    expect(suggestions()).not.toBeNull();

    realPress(buttonNamed('Cancel'));

    expect(container.textContent).not.toContain('Create new branch');
  });

  it('runs Create on the first click while the suggestions are open', async () => {
    const createBranch = jest.fn(() =>
      Promise.resolve({ success: true, branchName: 'feature' }),
    );
    Reflect.set(window.api, 'createBranch', createBranch);
    const input = await openCreateView(jest.fn());
    const nameField = Array.from(
      container.querySelectorAll<HTMLInputElement>('input'),
    ).find((field) => field !== input);
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameField, 'feature');
      nameField?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.focus());
    expect(suggestions()).not.toBeNull();

    await act(async () => {
      realPress(buttonNamed('Create'));
      await Promise.resolve();
    });

    expect(createBranch).toHaveBeenCalledTimes(1);
  });

  it('lets a click outside the picker land on the first try', async () => {
    // The picker sits in a dialog (Branch info) whose Close button, tabs and
    // other rows are outside the create view.
    const onDialogClose = jest.fn();
    const dialogClose = document.createElement('button');
    dialogClose.type = 'button';
    dialogClose.addEventListener('click', onDialogClose);
    document.body.appendChild(dialogClose);
    try {
      const input = await openCreateView(jest.fn());
      act(() => input.focus());
      expect(suggestions()).not.toBeNull();
      realPress(dialogClose);
      expect(onDialogClose).toHaveBeenCalledTimes(1);
      expect(suggestions()).toBeNull();
    } finally {
      dialogClose.remove();
    }
  });

  it('closes the suggestions on Escape without closing the picker', async () => {
    const onClose = jest.fn();
    const input = await openCreateView(onClose);
    act(() => input.focus());
    expect(suggestions()).not.toBeNull();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(suggestions()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
