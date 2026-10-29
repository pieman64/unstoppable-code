/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';
import { SingleRepoDetail } from '../PullRequestSection';
import type { RepoPrStatus } from '@canopy/desktop-shared/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const REPO: RepoPrStatus = {
  repoId: 'repo-1',
  repoName: 'repo-1',
  status: {
    prNumber: 42,
    prUrl: 'https://example.test/pr/42',
    state: 'open',
    title: 'Example PR',
    checkStatus: 'failing',
    checkDetails: [
      { name: 'build', status: 'passing', detailsUrl: null },
      { name: 'lint', status: 'failing', detailsUrl: null },
    ],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
};

describe('SingleRepoDetail frameless checks list', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('drops the checks max-height cap in frameless', () => {
    act(() => {
      root.render(
        <ActivitySectionChromeContext.Provider value="frameless">
          <SingleRepoDetail repo={REPO} />
        </ActivitySectionChromeContext.Provider>,
      );
    });
    expect(container.querySelector('.max-h-70')).toBeNull();
  });

  it('keeps the checks max-height cap in card mode', () => {
    act(() => {
      root.render(<SingleRepoDetail repo={REPO} />);
    });
    expect(container.querySelector('.max-h-70')).not.toBeNull();
  });
});
