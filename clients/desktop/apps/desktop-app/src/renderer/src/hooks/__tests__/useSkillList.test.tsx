/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSkillList } from '../useSkillList';
import {
  notifySkillsChanged,
  SKILLS_CHANGED_EVENT,
  trackSkillsRefresh,
} from '@/lib/skillsChanged';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
jest.mock('@/stores/agentArtifactInventoryStore', () => ({
  artifactInventoryScope: (): { generation: number; complete: boolean } => ({
    generation: 0,
    complete: true,
  }),
  observeArtifactSkills: jest.fn(),
}));
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    select: (state: { isEnabled: () => boolean }) => unknown,
  ): unknown => select({ isEnabled: (): boolean => false }),
}));
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: (
    select: (state: { appliedGeneration: number }) => unknown,
  ): unknown => select({ appliedGeneration: 0 }),
}));

it('reports a failed inventory refresh after mutation without rejecting legacy notifications', async () => {
  const loadSkills = jest.fn().mockResolvedValue({ success: true, data: [] });
  Object.assign(window, { skills: { loadSkills } });
  let inventory: ReturnType<typeof useSkillList> | undefined;
  function Harness(): null {
    inventory = useSkillList();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  const listener = (event: Event): void => {
    if (inventory) trackSkillsRefresh(event, inventory.refreshOrThrow());
  };
  window.addEventListener(SKILLS_CHANGED_EVENT, listener);
  try {
    loadSkills.mockResolvedValue({
      success: false,
      error: 'Inventory unavailable',
    });
    await act(async () => {
      await expect(
        notifySkillsChanged({ rejectOnFailure: true }),
      ).rejects.toThrow('Inventory unavailable');
    });
    expect(inventory?.error).toBe('Inventory unavailable');
    await act(async () => {
      await expect(notifySkillsChanged()).resolves.toBeUndefined();
    });
  } finally {
    window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    act(() => root.unmount());
  }
});
