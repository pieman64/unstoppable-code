/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, createRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChangedFileInfo,
  TurnDiffData,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { TurnDiffPopover } from '../TurnDiffPopover';

jest.mock('../../activity/DiffContentView', () => ({
  DiffContentView: (): JSX.Element => <div data-testid="diff-content" />,
}));

const FILE: ChangedFileInfo = {
  path: 'src/private/secret-feature.ts',
  insertions: 3,
  deletions: 1,
  status: 'modified',
};

const TURN_DIFF: TurnDiffData = {
  files: [FILE],
  totalInsertions: 3,
  totalDeletions: 1,
  capturedAt: 0,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      activity: {
        getFileDiff: jest.fn(
          () =>
            new Promise(() => {
              // Left pending: the test only inspects the portaled shell.
            }),
        ),
        getTurnFileDiff: jest.fn(),
      },
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

describe('TurnDiffPopover session-replay privacy', () => {
  it('records the portaled diff preview header', () => {
    const anchorRef = createRef<HTMLElement>();
    act(() => {
      root.render(
        <>
          <span ref={anchorRef} />
          <TurnDiffPopover
            file={FILE}
            turnDiff={TURN_DIFF}
            projectId="proj-1"
            worktreeId="wt-1"
            anchorRef={anchorRef}
            onMouseEnter={jest.fn()}
            onMouseLeave={jest.fn()}
            onOpenModal={jest.fn()}
            onEdit={jest.fn()}
          />
        </>,
      );
    });

    const popover = document.body.querySelector(
      ':scope > [data-canopy-browser-native-overlay="true"]',
    );
    expect(popover?.textContent).toContain(FILE.path);
    // The file path header is recorded; DiffContentView blocks the diff.
    expect(popover?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(popover?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
