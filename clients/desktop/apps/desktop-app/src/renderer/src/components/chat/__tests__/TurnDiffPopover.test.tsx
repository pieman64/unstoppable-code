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

// CAN-4070 rule: captured on unchanged code; CAN-4103 then removed the
// turn-to-current-combined fallback (Q-A, narrow). With tree refs the popover
// reads the turn's own trees; without matching ones it reads nothing and says
// the turn's changes weren't saved, instead of showing the worktree's
// current combined diff as if it were the turn's.
describe('TurnDiffPopover turn refs', () => {
  const START = 'a'.repeat(40);
  const END = 'b'.repeat(40);

  function renderPopover(
    file: ChangedFileInfo,
    turnDiff: TurnDiffData,
  ): { getFileDiff: jest.Mock; getTurnFileDiff: jest.Mock } {
    const getFileDiff = jest.fn(() => new Promise(() => undefined));
    const getTurnFileDiff = jest.fn(() => new Promise(() => undefined));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { activity: { getFileDiff, getTurnFileDiff } },
    });
    const anchorRef = createRef<HTMLElement>();
    act(() => {
      root.render(
        <>
          <span ref={anchorRef} />
          <TurnDiffPopover
            file={file}
            turnDiff={turnDiff}
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
    return { getFileDiff, getTurnFileDiff };
  }

  it('reads the turn trees when the turn recorded them', () => {
    const calls = renderPopover(FILE, {
      ...TURN_DIFF,
      treeRefs: [{ startTree: START, endTree: END }],
    });
    expect(calls.getFileDiff).not.toHaveBeenCalled();
    expect(calls.getTurnFileDiff.mock.calls).toEqual([
      [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          filePath: FILE.path,
          startTree: START,
          endTree: END,
          repoId: undefined,
        },
      ],
    ]);
  });

  it("matches a multi-repo file to its repository's trees", () => {
    const file = { ...FILE, repoId: 'beta' };
    const calls = renderPopover(file, {
      ...TURN_DIFF,
      files: [file],
      treeRefs: [
        { startTree: START, endTree: START, repoId: 'alpha' },
        { startTree: START, endTree: END, repoId: 'beta' },
      ],
    });
    expect(calls.getTurnFileDiff.mock.calls).toEqual([
      [expect.objectContaining({ endTree: END, repoId: 'beta' })],
    ]);
  });

  it('reads nothing and shows the unavailable state without matching tree refs', () => {
    for (const turnDiff of [
      TURN_DIFF,
      { ...TURN_DIFF, treeRefs: [] },
      {
        ...TURN_DIFF,
        treeRefs: [
          { startTree: START, endTree: END, repoId: 'alpha' },
          { startTree: START, endTree: END, repoId: 'beta' },
        ],
      },
    ]) {
      const calls = renderPopover(FILE, turnDiff);
      expect(calls.getTurnFileDiff).not.toHaveBeenCalled();
      expect(calls.getFileDiff).not.toHaveBeenCalled();
      const popover = document.body.querySelector(
        '[data-testid="turn-diff-popover"]',
      );
      expect(
        popover?.querySelector(
          '[data-testid="diff-viewer-notice-turn-unavailable"]',
        )?.textContent,
      ).toBe(
        "This turn's changes weren't saved, so they can't be shown.Expand to see all branch changes for this file.",
      );
      expect(popover?.querySelector('[data-testid="diff-content"]')).toBeNull();
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
    }
  });
});
