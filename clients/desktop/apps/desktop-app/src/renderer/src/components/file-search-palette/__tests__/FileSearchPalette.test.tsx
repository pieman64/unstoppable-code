/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useChatStore } from '@/stores/chatStore';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { FileSearchPalette } from '../FileSearchPalette';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  useFileListStore.setState({
    indexCache: {},
    indexErrors: {},
    indexLoading: new Set<string>(),
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

function render(): void {
  act(() => {
    root.render(<FileSearchPalette initialQuery="" onClose={jest.fn()} />);
  });
}

function scrollContainer(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="file-search-palette-scroll"]',
  );
}

describe('FileSearchPalette session-replay privacy', () => {
  it('records the results container in session replay', () => {
    render();

    const results = scrollContainer();
    expect(results?.parentElement?.getAttribute('data-testid')).toBe(
      'file-search-palette',
    );
    expect(results?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('records an index error inside the results container', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });
    useFileListStore.setState({
      indexErrors: {
        [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]:
          'Unable to index /private/repo',
      },
    });
    render();

    const error = Array.from(container.querySelectorAll('div')).find(
      (element) => element.textContent === 'Unable to index /private/repo',
    );
    expect(error).not.toBeUndefined();
    expect(error?.closest('[data-testid="file-search-palette-scroll"]')).toBe(
      scrollContainer(),
    );
    expect(error?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
