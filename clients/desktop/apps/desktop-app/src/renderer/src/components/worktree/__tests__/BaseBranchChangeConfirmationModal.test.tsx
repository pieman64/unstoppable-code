/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BaseBranchChangeConfirmationModalHost } from '../BaseBranchChangeConfirmationModal';
import { useBaseBranchChangeStore } from '@/stores/baseBranchChangeStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('BaseBranchChangeConfirmationModalHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBaseBranchChangeStore.getState().resolveConfirmation(null);
    useCurrentUiStateStore.setState({ slices: {} });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    useBaseBranchChangeStore.getState().resolveConfirmation(null);
    document.body.replaceChildren();
  });

  it.each([
    ['No, just locally', 'local-only'],
    ['Yes, update PR', 'update-pr'],
  ] as const)('resolves %s as %s', async (label, expected) => {
    let resultPromise: Promise<'local-only' | 'update-pr' | null> =
      Promise.resolve(null);
    await act(async () => {
      resultPromise = useBaseBranchChangeStore.getState().requestConfirmation({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoName: 'Repo One',
        baseBranch: 'release/next',
        prNumber: 42,
      });
      root.render(<BaseBranchChangeConfirmationModalHost />);
      await Promise.resolve();
    });

    const dialog = document.body.querySelector<HTMLElement>(
      '[data-testid="base-branch-change-confirmation"]',
    );
    expect(dialog?.textContent).toContain('Update PR base branch?');
    expect(dialog?.textContent).toContain('Repo One');
    expect(dialog?.textContent).toContain('PR #42');
    expect(dialog?.textContent).toContain('release/next');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot
        .baseBranchChangeConfirmationModal,
    ).toEqual({
      open: true,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseBranch: 'release/next',
      prNumber: 42,
    });

    const button = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((candidate) => candidate.textContent?.includes(label));
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    await expect(resultPromise).resolves.toBe(expected);
    expect(useBaseBranchChangeStore.getState().pending).toBeNull();
  });

  const queryDialog = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(
      '[data-testid="base-branch-change-confirmation"]',
    );

  async function requestForWorktreeOne(): Promise<{
    result: Promise<'local-only' | 'update-pr' | null>;
  }> {
    let result: Promise<'local-only' | 'update-pr' | null> =
      Promise.resolve(null);
    await act(async () => {
      result = useBaseBranchChangeStore.getState().requestConfirmation({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoName: 'Repo One',
        baseBranch: 'release/next',
        prNumber: 42,
      });
      root.render(<BaseBranchChangeConfirmationModalHost />);
      await Promise.resolve();
    });
    // Wrapped so awaiting this helper does not await the confirmation.
    return { result };
  }

  it.each([
    [
      'another worktree is selected',
      (): void =>
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-1',
            worktreeId: 'worktree-2',
          },
        }),
    ],
    [
      'Settings is open',
      (): void => useNavigationStore.setState({ settingsOpen: true }),
    ],
    [
      'another page is showing',
      (): void => useNavigationStore.setState({ activePage: 'overview' }),
    ],
  ])('applies locally without asking when %s', async (_label, hideWorktree) => {
    hideWorktree();
    const { result: resultPromise } = await requestForWorktreeOne();

    await expect(resultPromise).resolves.toBe('local-only');
    expect(queryDialog()).toBeNull();
    expect(useBaseBranchChangeStore.getState().pending).toBeNull();
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot
        .baseBranchChangeConfirmationModal,
    ).toBeUndefined();
  });

  it('applies locally when the user leaves the worktree while asked', async () => {
    const { result: resultPromise } = await requestForWorktreeOne();
    expect(queryDialog()?.textContent).toContain('Update PR base branch?');

    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-2' },
      });
      await Promise.resolve();
    });

    await expect(resultPromise).resolves.toBe('local-only');
    expect(queryDialog()).toBeNull();
  });

  it('cancels a superseded confirmation so concurrent actions cannot hang', async () => {
    const first = useBaseBranchChangeStore.getState().requestConfirmation({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoName: 'Repo One',
      baseBranch: 'develop',
      prNumber: 42,
    });
    const second = useBaseBranchChangeStore.getState().requestConfirmation({
      projectId: 'project-1',
      worktreeId: 'worktree-2',
      repoName: 'Repo Two',
      baseBranch: 'main',
      prNumber: 43,
    });

    await expect(first).resolves.toBeNull();
    useBaseBranchChangeStore.getState().resolveConfirmation('local-only');
    await expect(second).resolves.toBe('local-only');
  });
});
