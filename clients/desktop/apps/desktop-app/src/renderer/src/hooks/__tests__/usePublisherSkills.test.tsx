/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePublisherSkills } from '../usePublisherSkills';
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (select: (state: unknown) => unknown): unknown =>
    select({ isEnabled: () => false }),
}));
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: (select: (state: unknown) => unknown): unknown =>
    select({ appliedGeneration: 0 }),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
let result: ReturnType<typeof usePublisherSkills>;
function Harness(): null {
  result = usePublisherSkills();
  return null;
}
const list = jest.fn();
const row = {
  externalId: 'publisher-id',
  name: 'guide',
  description: '',
  publisher: 'Anthropic',
};
let root: Root;
beforeEach(() => {
  list.mockReset().mockResolvedValue([row]);
  Object.defineProperty(window, 'skills', {
    configurable: true,
    value: { listMarketplace: list },
  });
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});
async function mount(): Promise<void> {
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
}
it('loads public metadata without requiring an account or install', async () => {
  await mount();
  expect(result.skills).toEqual([row]);
  expect(result.loading).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
});
it('ignores an older response after refresh or revocation', async () => {
  let finish!: (rows: unknown[]) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  list.mockResolvedValueOnce([]);
  await act(async () => {
    await result.refresh();
  });
  await act(async () => {
    finish([row]);
    await Promise.resolve();
  });
  expect(result.skills).toEqual([]);
});
it('shows a retryable failure, then recovers', async () => {
  list.mockRejectedValueOnce(new Error('Offline'));
  await mount();
  expect(result.error).toContain('Try again');
  await act(async () => {
    await result.refresh();
  });
  expect(result.error).toBeNull();
  expect(result.skills).toEqual([row]);
});
it('refreshes installation markers after a skill mutation', async () => {
  await mount();
  list.mockResolvedValueOnce([{ ...row, installedSkillName: 'guide-2' }]);
  await act(async () => {
    window.dispatchEvent(new Event('canopy:skills-changed'));
    await Promise.resolve();
  });
  expect(result.skills[0].installedSkillName).toBe('guide-2');
});
