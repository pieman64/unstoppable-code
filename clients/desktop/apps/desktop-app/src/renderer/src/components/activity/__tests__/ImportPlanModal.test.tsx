/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useActivityStore } from '@/stores/activityStore';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { ImportPlanModal } from '../ImportPlanModal';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useActivityStore.setState({
    detectedPlans: {},
    loadDetectedPlans: jest.fn(() => Promise.resolve()),
  });
  // An index error keeps the modal from fetching and shows in the results.
  useFileListStore.setState({
    indexCache: {},
    indexLoading: new Set<string>(),
    indexErrors: {
      [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]:
        'Unable to index /private/repo',
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

describe('ImportPlanModal session-replay privacy', () => {
  it('records the card, including the worktree path in the error', () => {
    act(() => {
      root.render(
        <ImportPlanModal
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          onClose={jest.fn()}
          onImported={jest.fn()}
        />,
      );
    });

    const card = container.querySelector('[data-testid="import-plan-modal"]');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.textContent).toContain('Unable to index /private/repo');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });
});
