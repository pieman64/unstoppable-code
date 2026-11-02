import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { importDetectedPlan } from '../import-detected-plan';

const ENTRY: DetectedPlanEntry = {
  id: 'entry-1',
  sourceRepoId: 'repo-1',
  sourceFilePath: 'docs/plan.md',
  status: 'detected',
  bannerSeen: false,
  detectedInChatId: 'chat-1',
  detectedAt: '2026-10-01T00:00:00.000Z',
};
const PLAN: Pick<TrackedPlanData, 'id'> = { id: 'plan-1' };

let importTrackedPlan: jest.Mock;
let updateDetectedPlan: jest.Mock;
let queuePlanImportInstruction: jest.Mock;

beforeEach(() => {
  importTrackedPlan = jest.fn().mockResolvedValue(PLAN);
  updateDetectedPlan = jest.fn().mockResolvedValue(undefined);
  queuePlanImportInstruction = jest.fn();
  useActivityStore.setState({ importTrackedPlan, updateDetectedPlan });
  useChatStore.setState({ queuePlanImportInstruction });
});

describe('importDetectedPlan', () => {
  it('imports, marks the entry imported, and tells the origin chat', async () => {
    await expect(
      importDetectedPlan({
        projectId: 'p',
        worktreeId: 'w',
        entry: ENTRY,
        originChatId: 'chat-1',
      }),
    ).resolves.toBe(PLAN);

    expect(importTrackedPlan).toHaveBeenCalledWith(
      'p',
      'w',
      'docs/plan.md',
      'repo-1',
    );
    expect(updateDetectedPlan).toHaveBeenCalledWith('p', 'w', 'entry-1', {
      status: 'imported',
      importedPlanId: 'plan-1',
    });
    expect(queuePlanImportInstruction).toHaveBeenCalledWith(
      'chat-1',
      'docs/plan.md',
    );
  });

  it('queues no instruction without an origin chat', async () => {
    await importDetectedPlan({ projectId: 'p', worktreeId: 'w', entry: ENTRY });

    expect(updateDetectedPlan).toHaveBeenCalled();
    expect(queuePlanImportInstruction).not.toHaveBeenCalled();
  });

  it('leaves the entry and the chat alone when nothing was imported', async () => {
    importTrackedPlan.mockResolvedValue(null);

    await expect(
      importDetectedPlan({
        projectId: 'p',
        worktreeId: 'w',
        entry: ENTRY,
        originChatId: 'chat-1',
      }),
    ).resolves.toBeNull();
    expect(updateDetectedPlan).not.toHaveBeenCalled();
    expect(queuePlanImportInstruction).not.toHaveBeenCalled();
  });

  it('still resolves the plan and tells the chat when the status update fails', async () => {
    updateDetectedPlan.mockRejectedValue(new Error('disk full'));

    await expect(
      importDetectedPlan({
        projectId: 'p',
        worktreeId: 'w',
        entry: ENTRY,
        originChatId: 'chat-1',
      }),
    ).resolves.toBe(PLAN);
    expect(queuePlanImportInstruction).toHaveBeenCalled();
  });

  it('rejects when the import fails', async () => {
    importTrackedPlan.mockRejectedValue(new Error('File not found'));

    await expect(
      importDetectedPlan({ projectId: 'p', worktreeId: 'w', entry: ENTRY }),
    ).rejects.toThrow('File not found');
    expect(updateDetectedPlan).not.toHaveBeenCalled();
  });
});
