/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { PrPickerOption } from '@/stores/navigationStore';
import { PrPicker } from '../PrPicker';
import { openUrlExternally } from '../openUrlExternally';

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
  jest.clearAllMocks();
});

function pressKey(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

function search(): HTMLInputElement {
  const input = document.querySelector('[data-testid="pr-picker-input"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('pr picker search field not found');
  }
  return input;
}

describe('PrPicker session-replay privacy', () => {
  it('records the pull request results in session replay', () => {
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={jest.fn()} />);
    });

    // DialogModal portals the card into the document body.
    const card = document.querySelector('[data-testid="pr-picker"]');
    const results = card?.querySelector(
      '[role="listbox"][aria-label="Pull requests"]',
    );
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(results?.textContent).toContain('Private pull request title');
    expect(results?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});

describe('PrPicker', () => {
  it('names the dialog and focuses the search field', () => {
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={jest.fn()} />);
    });

    const card = document.querySelector('[data-testid="pr-picker"]');
    const labelId = card?.getAttribute('aria-labelledby');
    expect(labelId ? document.getElementById(labelId)?.textContent : null).toBe(
      'Open pull request',
    );
    expect(document.activeElement).toBe(search());
  });

  it('opens the highlighted pull request on Enter and closes', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={onClose} />);
    });

    pressKey(search(), 'Enter');

    expect(openUrlExternally).toHaveBeenCalledWith(OPTIONS[0]?.prUrl);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with the arrows before opening', () => {
    const second: PrPickerOption = {
      repoId: 'repo-2',
      repoName: 'api',
      prNumber: 7,
      prUrl: 'https://github.com/example/api/pull/7',
      prTitle: 'Second pull request',
      prState: 'merged',
    };
    act(() => {
      root.render(
        <PrPicker options={[...OPTIONS, second]} onClose={jest.fn()} />,
      );
    });

    pressKey(search(), 'ArrowDown');
    expect(
      document
        .querySelector('[data-testid="pr-picker-option-repo-2-7"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    pressKey(search(), 'Enter');

    expect(openUrlExternally).toHaveBeenCalledWith(second.prUrl);
  });

  it('closes on Escape from the search field', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={onClose} />);
    });

    pressKey(search(), 'Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop press', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(<PrPicker options={OPTIONS} onClose={onClose} />);
    });

    const backdrop = document.querySelector(
      '[data-testid="pr-picker"]',
    )?.parentElement;
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
