/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  HomeBranchTargetsResponse,
  SwitchBranchRequest,
} from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  useWorktreeBranchChange,
  type WorktreeBranchChange,
} from '../useWorktreeBranchChange';

const TARGETS: HomeBranchTargetsResponse = {
  supported: true,
  defaultBranch: 'develop',
  branches: [
    {
      name: 'feature/next',
      isRemote: false,
      isCurrent: false,
      isUsedByWorktree: false,
      hasLocalRef: true,
      hasRemoteRef: true,
    },
  ],
};

const NEXT_BRANCH = {
  kind: 'branch',
  branchName: 'feature/next',
  isRemote: false,
} as const;

interface Deferred {
  request: SwitchBranchRequest;
  resolve: () => void;
}

let container: HTMLDivElement;
let root: Root;
let latest: WorktreeBranchChange | null = null;
let switches: Deferred[] = [];
const addToast = jest.fn();

function Harness({ worktreeId }: { worktreeId: string }): JSX.Element | null {
  latest = useWorktreeBranchChange({
    projectId: 'project-1',
    worktreeId,
    currentBranch: 'feature/current',
    baseBranch: 'develop',
  });
  return null;
}

function hook(): WorktreeBranchChange {
  if (!latest) throw new Error('hook not rendered');
  return latest;
}

/** Runs `update` and lets the hook's pending promises settle. */
async function settle(update: () => void): Promise<void> {
  await act(() => {
    update();
    return Promise.resolve();
  });
}

async function render(worktreeId: string): Promise<void> {
  await settle(() => root.render(<Harness worktreeId={worktreeId} />));
}

async function openAndPick(): Promise<void> {
  await settle(() => hook().openPicker());
  await settle(() => hook().selectTarget(NEXT_BRANCH));
}

beforeEach(() => {
  switches = [];
  addToast.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      homeListBranchTargets: jest.fn(() => Promise.resolve(TARGETS)),
      switchBranch: jest.fn(
        (request: SwitchBranchRequest) =>
          new Promise<{ success: true; branchName: string }>((resolve) => {
            switches.push({
              request,
              resolve: () =>
                resolve({ success: true, branchName: request.branchName }),
            });
          }),
      ),
      createBranch: jest.fn(),
    },
  });
  useGitHubStore.setState({ addToast });
  useProjectsStore.setState({
    updateBranchName: jest.fn(),
    refreshDiffStats: jest.fn(() => Promise.resolve()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  latest = null;
});

describe('useWorktreeBranchChange', () => {
  it('switches a second worktree while the first one is still switching', async () => {
    await render('worktree-a');
    await openAndPick();
    expect(switches.map((entry) => entry.request.worktreeId)).toEqual([
      'worktree-a',
    ]);

    // The header stays mounted when the open worktree changes.
    await render('worktree-b');
    await openAndPick();

    expect(switches.map((entry) => entry.request.worktreeId)).toEqual([
      'worktree-a',
      'worktree-b',
    ]);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('says so when a pick arrives while that worktree is still switching', async () => {
    await render('worktree-a');
    await openAndPick();
    await openAndPick();

    expect(switches).toHaveLength(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('still switching'),
      'info',
    );

    await settle(() => switches[0]?.resolve());
    await openAndPick();
    expect(switches).toHaveLength(2);
  });
});
