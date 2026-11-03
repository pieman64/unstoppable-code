/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
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

// DialogModal portals the palette into the document body.
function scrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="file-search-palette-scroll"]',
  );
}

describe('FileSearchPalette session-replay privacy', () => {
  it('masks the Cowork project subtitle and opens files using the unchanged path', () => {
    const openFileTab = jest.fn();
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      openFileTab,
    });
    useFileListStore.setState({
      indexCache: {
        [getWorktreeCacheKey(PROJECT_ID, WORKTREE_ID)]: {
          fetchedAt: Date.now(),
          data: {
            repos: [
              {
                repoId: 'workspace',
                repoName: 'Vendor Spend Q3',
                absolutePath: '/vendor',
                rootKind: 'standalone',
                files: [
                  {
                    relativePath: 'spend.csv',
                    filename: 'spend.csv',
                    absolutePath: '/vendor/spend.csv',
                    isIgnored: false,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    render();
    const result = document.querySelector<HTMLButtonElement>(
      '[data-testid="file-search-palette-result"]',
    );
    expect(result?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Vendor Spend Q3',
    );
    act(() => result?.click());
    expect(openFileTab).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: '/vendor/spend.csv' }),
    );
  });
  it('records the results container in session replay', () => {
    render();

    const results = scrollContainer();
    expect(
      results?.closest('[data-testid="file-search-palette"]'),
    ).not.toBeNull();
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

    const error = Array.from(document.querySelectorAll('div')).find(
      (element) => element.textContent === 'Unable to index /private/repo',
    );
    expect(error).not.toBeUndefined();
    expect(error?.closest('[data-testid="file-search-palette-scroll"]')).toBe(
      scrollContainer(),
    );
    expect(error?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('closes once on Escape from the search field', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(<FileSearchPalette initialQuery="" onClose={onClose} />);
    });
    const input = document.querySelector(
      '[data-testid="file-search-palette-input"]',
    );
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop press', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(<FileSearchPalette initialQuery="" onClose={onClose} />);
    });
    const backdrop = document.querySelector(
      '[data-testid="file-search-palette"]',
    )?.parentElement;
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
