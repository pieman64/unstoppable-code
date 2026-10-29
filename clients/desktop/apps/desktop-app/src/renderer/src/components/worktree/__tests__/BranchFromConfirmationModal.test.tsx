/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useBranchFromStore } from '@/stores/branchFromStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { BranchFromConfirmationModalHost } from '../BranchFromConfirmationModal';

describe('BranchFromConfirmationModalHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    useBranchFromStore.getState().resolveConfirmation(null);
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers commit-first and do-not-commit choices under Continue', async () => {
    const result = useBranchFromStore
      .getState()
      .requestConfirmation('project', 'worktree');
    const confirmationId =
      useBranchFromStore.getState().pending?.confirmationId;
    act(() => {
      root.render(<BranchFromConfirmationModalHost />);
    });

    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="branch-from-uncommitted-warning"]',
    );
    expect(dialog?.textContent).toContain(
      "Uncommitted changes won't be carried over",
    );
    expect(dialog?.textContent).toContain('Cancel');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.branchFromModal,
    ).toEqual({
      open: true,
      confirmationId,
      projectId: 'project',
      worktreeId: 'worktree',
      menuOpen: false,
    });

    const continueButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.trim() === 'Continue');
    act(() => continueButton?.click());
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.branchFromModal?.menuOpen,
    ).toBe(true);

    const commitFirstButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === 'Commit first');
    const doNotCommitButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === 'Do not commit');
    expect(commitFirstButton).toBeDefined();
    expect(doNotCommitButton).toBeDefined();
    // Both choices are variants of one action: they share one icon, drawn
    // on the first row only, and the second keeps the empty slot.
    expect(
      commitFirstButton?.firstElementChild?.querySelector('svg'),
    ).not.toBeNull();
    expect(
      doNotCommitButton?.firstElementChild?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      doNotCommitButton?.firstElementChild?.querySelector('svg'),
    ).toBeNull();

    act(() => commitFirstButton?.click());
    await expect(result).resolves.toBe('commit-first');
  });

  it('resolves cancellation from the Cancel button', async () => {
    const result = useBranchFromStore
      .getState()
      .requestConfirmation('project', 'worktree');
    act(() => {
      root.render(<BranchFromConfirmationModalHost />);
    });

    const cancelButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Cancel');
    act(() => cancelButton?.click());

    await expect(result).resolves.toBeNull();
  });
});
