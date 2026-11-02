/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { PlanDetectionBanner } from '../PlanDetectionBanner';

jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn().mockResolvedValue({ status: 'placed' }),
}));

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const CHAT_ID = 'chat-1';
const PLAN: Pick<TrackedPlanData, 'id'> = { id: 'plan-1' };

let container: HTMLDivElement;
let root: Root;
let importTrackedPlan: jest.Mock;
let updateDetectedPlan: jest.Mock;
let openImportModal: jest.Mock;
let addToast: jest.Mock;
let queuePlanImportInstruction: jest.Mock;
let loadTrackedPlans: jest.Mock;
const openTrackedPlanMock = jest.mocked(openTrackedPlan);

function entry(id: string, path = `docs/${id}.md`): DetectedPlanEntry {
  return {
    id,
    sourceRepoId: 'repo-1',
    sourceFilePath: path,
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: CHAT_ID,
    detectedAt: '2026-10-01T00:00:00.000Z',
  };
}

function importedPlan(
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return {
    id: 'plan-existing',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'imported',
    sourceRepoId: 'repo-1',
    sourceFilePath: 'docs/rollout.md',
    title: 'Rollout',
    content: '# Rollout',
    reviewStatus: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function banner(): JSX.Element {
  return (
    <PlanDetectionBanner
      projectId={PROJECT_ID}
      worktreeId={WORKTREE_ID}
      chatId={CHAT_ID}
    />
  );
}

function render(node: JSX.Element = banner()): void {
  act(() => {
    root.render(node);
  });
}

function q(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function clickImport(): Promise<void> {
  await act(async () => {
    q('plan-detection-banner-import')?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  importTrackedPlan = jest.fn().mockResolvedValue(PLAN);
  updateDetectedPlan = jest.fn().mockResolvedValue(undefined);
  openImportModal = jest.fn();
  addToast = jest.fn();
  queuePlanImportInstruction = jest.fn();
  loadTrackedPlans = jest.fn().mockResolvedValue(undefined);
  openTrackedPlanMock.mockClear();
  useActivityStore.setState({
    detectedPlans: { [KEY]: [entry('rollout')] },
    trackedPlans: {},
    trackedPlanInventoryLoaded: { [KEY]: true },
    loadTrackedPlans,
    importTrackedPlan,
    updateDetectedPlan,
    openImportModal,
  });
  useGitHubStore.setState({ addToast });
  useChatStore.setState({ queuePlanImportInstruction });
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

describe('PlanDetectionBanner', () => {
  it('names the single file and imports it in place', async () => {
    render();

    expect(q('plan-detection-banner')?.textContent).toContain(
      'Track rollout.md as a plan?',
    );
    expect(q('plan-detection-banner')?.textContent).toContain(
      'Review and comment on it in Plans, then implement it from there.',
    );
    expect(q('plan-detection-banner-import')?.textContent).toBe('Track plan');

    await clickImport();

    expect(importTrackedPlan).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'docs/rollout.md',
      'repo-1',
    );
    expect(openImportModal).not.toHaveBeenCalled();
    expect(queuePlanImportInstruction).toHaveBeenCalledWith(
      CHAT_ID,
      'docs/rollout.md',
    );
    expect(openTrackedPlanMock).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, planId: 'plan-1' },
      { navigate: false, origin: { chatTabId: CHAT_ID } },
    );
    // The status update failed to land in the store here, so the notice
    // hides itself rather than offering a second import.
    expect(q('plan-detection-banner')).toBeNull();
  });

  it('disables Track plan while the import runs', async () => {
    let resolveImport: (plan: Pick<TrackedPlanData, 'id'>) => void = () =>
      undefined;
    importTrackedPlan.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    render();

    await clickImport();
    expect(q('plan-detection-banner-import')?.hasAttribute('disabled')).toBe(
      true,
    );
    await clickImport();
    expect(importTrackedPlan).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveImport(PLAN);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(q('plan-detection-banner')).toBeNull();
  });

  it('ignores a second click while it checks the tracked plans', async () => {
    useActivityStore.setState({ trackedPlanInventoryLoaded: {} });
    let finishLoad: () => void = () => undefined;
    loadTrackedPlans.mockReturnValue(
      new Promise<void>((resolve) => {
        finishLoad = resolve;
      }),
    );
    render();

    // Both clicks land before React re-renders the disabled button.
    act(() => {
      q('plan-detection-banner-import')?.click();
      q('plan-detection-banner-import')?.click();
    });
    await act(async () => {
      finishLoad();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadTrackedPlans).toHaveBeenCalledTimes(1);
    expect(importTrackedPlan).toHaveBeenCalledTimes(1);
  });

  it('shows an error toast and re-enables when the import fails', async () => {
    importTrackedPlan.mockRejectedValue(new Error('File not found'));
    render();

    await clickImport();

    expect(addToast).toHaveBeenCalledWith(
      'File not found',
      'error',
      undefined,
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    expect(q('plan-detection-banner-import')?.hasAttribute('disabled')).toBe(
      false,
    );
    expect(openTrackedPlanMock).not.toHaveBeenCalled();
  });

  it('opens the picker to review several files', async () => {
    useActivityStore.setState({
      detectedPlans: { [KEY]: [entry('a'), entry('b')] },
    });
    render();

    expect(q('plan-detection-banner')?.textContent).toContain(
      '2 plan files found',
    );
    expect(q('plan-detection-banner-import')?.textContent).toBe(
      'Review 2 files…',
    );
    await clickImport();

    expect(importTrackedPlan).not.toHaveBeenCalled();
    expect(openImportModal).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      originChatId: CHAT_ID,
    });
  });

  it('marks every pending entry seen on dismiss', () => {
    useActivityStore.setState({
      detectedPlans: { [KEY]: [entry('a'), entry('b')] },
    });
    render();

    act(() => {
      q('plan-detection-banner-dismiss')?.click();
    });

    expect(updateDetectedPlan).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'a',
      { bannerSeen: true },
    );
    expect(updateDetectedPlan).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'b',
      { bannerSeen: true },
    );
  });

  it('stays hidden when the file is already a tracked plan', () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [importedPlan()] } });
    render();

    expect(q('plan-detection-banner')).toBeNull();
  });

  it('opens the existing plan instead of importing a duplicate', async () => {
    // The tracked inventory has not loaded yet, so the notice still shows.
    useActivityStore.setState({ trackedPlanInventoryLoaded: {} });
    loadTrackedPlans.mockImplementation((): Promise<void> => {
      useActivityStore.setState({
        trackedPlans: { [KEY]: [importedPlan()] },
        trackedPlanInventoryLoaded: { [KEY]: true },
      });
      return Promise.resolve();
    });
    render();
    expect(q('plan-detection-banner')).not.toBeNull();

    await clickImport();

    expect(loadTrackedPlans).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(importTrackedPlan).not.toHaveBeenCalled();
    expect(updateDetectedPlan).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'rollout',
      { status: 'imported', importedPlanId: 'plan-existing' },
    );
    expect(openTrackedPlanMock).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-existing',
      },
      { navigate: false, origin: { chatTabId: CHAT_ID } },
    );
    // Tracking from the chat tells it about the plan either way.
    expect(queuePlanImportInstruction).toHaveBeenCalledWith(
      CHAT_ID,
      'docs/rollout.md',
    );
    expect(q('plan-detection-banner')).toBeNull();
  });

  it('stays hidden in a read-only scope', () => {
    render(
      <WorkspaceAccessContext.Provider
        value={{
          mode: 'read-only',
          reason: 'shared-container',
          containerType: 'CODE_WORKTREE',
          runAllowed: false,
        }}
      >
        {banner()}
      </WorkspaceAccessContext.Provider>,
    );

    expect(q('plan-detection-banner')).toBeNull();
  });
});
