/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { PrPickerOption } from '@/stores/navigationStore';
import { PrPicker } from '../PrPicker';

jest.mock('../openUrlExternally', () => ({
  openUrlExternally: jest.fn(),
}));

const OPTIONS: PrPickerOption[] = [
  {
    repoId: 'repo-1',
    repoName: 'app',
    prNumber: 42,
    prUrl: 'https://github.com/example/app/pull/42',
    prTitle: 'Private pull request title',
    prState: 'open',
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe('PrPicker session-replay privacy', () => {
  it('records the pull request results in session replay', () => {
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={jest.fn()} />);
    });

    const results = container.querySelector(
      '[role="listbox"][aria-label="Pull requests"]',
    )?.parentElement;
    expect(results?.parentElement?.getAttribute('data-testid')).toBe(
      'pr-picker',
    );
    expect(results?.textContent).toContain('Private pull request title');
    expect(results?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
