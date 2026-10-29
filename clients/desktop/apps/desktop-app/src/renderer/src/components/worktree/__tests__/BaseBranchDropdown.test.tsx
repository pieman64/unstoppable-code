/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BaseBranchDropdown } from '../BaseBranchDropdown';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const listBranches = jest.fn();

describe('BaseBranchDropdown', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    listBranches.mockResolvedValue({
      branches: [
        {
          name: 'main',
          isRemote: false,
          isCurrent: true,
          isUsedByWorktree: false,
          hasLocalRef: true,
          hasRemoteRef: true,
        },
        {
          name: 'feature/a-very-long-branch-name',
          isRemote: true,
          isCurrent: false,
          isUsedByWorktree: false,
          hasLocalRef: false,
          hasRemoteRef: true,
        },
      ],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listBranches },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.clearAllMocks();
  });

  async function openPicker(onChange = jest.fn()): Promise<void> {
    act(() => {
      root.render(
        <BaseBranchDropdown
          projectId="project"
          worktreeId="worktree"
          currentValue="main"
          onChange={onChange}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="base-branch-dropdown-trigger"]',
    );
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('uses the shared searchable picker shell and fixed row rails', async () => {
    await openPicker();

    const menu = document.querySelector<HTMLElement>(
      '[data-testid="base-branch-dropdown-menu"]',
    );
    const search = menu?.querySelector<HTMLInputElement>(
      '[aria-label="Search branches"]',
    );
    const selected = menu?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );

    expect(menu?.classList).toContain('canopy-picker-menu');
    // The 32px rail moved to the search field wrapper that carries the
    // magnifying glass; the input itself just fills it.
    expect(search?.className).not.toContain('h-8');
    expect(
      search?.closest('.canopy-picker-menu-search-field')?.className,
    ).toContain('h-8');
    expect(search?.className).toContain('border-0');
    expect(search?.className).toContain('bg-transparent');
    expect(selected?.className).toContain('min-h-8');
    expect(selected?.className).toContain('py-2');
    expect(selected?.querySelector('.h-4.w-4.shrink-0')).not.toBeNull();
    expect(selected?.querySelector('.min-w-0.flex-1')).not.toBeNull();
    expect(
      selected?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
  });

  it('arrows through filtered rows, selects on Enter, and returns focus', async () => {
    const onChange = jest.fn();
    await openPicker(onChange);
    const search = document.querySelector<HTMLInputElement>(
      '[aria-label="Search branches"]',
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="base-branch-dropdown-trigger"]',
    );

    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onChange).toHaveBeenCalledWith('feature/a-very-long-branch-name', {
      existsLocally: false,
      existsInRemote: true,
    });
    expect(
      document.querySelector('[data-testid="base-branch-dropdown-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows each branch name once in the trigger and the options', async () => {
    await openPicker();

    const triggerLabel = container.querySelector(
      '[data-testid="base-branch-dropdown-trigger"] > span',
    );
    expect(triggerLabel?.textContent).toBe('main');

    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(2);
    for (const option of options) {
      const name = option.dataset.branchName ?? '';
      const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT);
      const nameParents: Element[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent === name && node.parentElement) {
          nameParents.push(node.parentElement);
        }
      }
      expect(nameParents).toHaveLength(1);
    }
  });

  it('does not open or load branches when disabled', () => {
    act(() => {
      root.render(
        <BaseBranchDropdown
          projectId="project"
          worktreeId="worktree"
          currentValue="main"
          disabled
          onChange={jest.fn()}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="base-branch-dropdown-trigger"]',
    );

    act(() => trigger?.click());

    expect(trigger?.disabled).toBe(true);
    expect(listBranches).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="base-branch-dropdown-menu"]'),
    ).toBeNull();
  });
});
