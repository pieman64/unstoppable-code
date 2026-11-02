/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// CAN-4070 rule: captured on unchanged code; CAN-4103 then removed the
// turn-to-current-combined fallback (Q-A, narrow). A turn context with both
// trees reads them; one without reads nothing and reports no snapshot and no
// error, so the viewer shows the turn as unavailable.
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileDiffContext } from '@canopy/desktop-shared/types/code-review';
import {
  isTurnDiffUnavailable,
  useFileDiffSnapshot,
} from '../useFileDiffSnapshot';

const START = 'a'.repeat(40);
const END = 'b'.repeat(40);

let container: HTMLDivElement;
let root: Root;
let getFileDiff: jest.Mock;
let getTurnFileDiff: jest.Mock;

beforeEach(() => {
  getFileDiff = jest.fn(() => new Promise(() => undefined));
  getTurnFileDiff = jest.fn(() => new Promise(() => undefined));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { getFileDiff, getTurnFileDiff } },
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

let lastResult: ReturnType<typeof useFileDiffSnapshot> | undefined;

function Probe({ context }: { context: FileDiffContext }): JSX.Element {
  lastResult = useFileDiffSnapshot('proj-1', 'wt-1', context, true, 0);
  return <div />;
}

function render(context: FileDiffContext): void {
  act(() => {
    root.render(<Probe context={context} />);
  });
}

describe('useFileDiffSnapshot turn contexts', () => {
  it('reads the turn trees when both are present', () => {
    render({
      path: 'src/a.ts',
      repoId: 'beta',
      source: 'turn',
      startTree: START,
      endTree: END,
    });
    expect(getFileDiff).not.toHaveBeenCalled();
    expect(getTurnFileDiff.mock.calls).toEqual([
      [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          filePath: 'src/a.ts',
          repoId: 'beta',
          startTree: START,
          endTree: END,
        },
      ],
    ]);
  });

  it('reads nothing for a turn without both trees', () => {
    for (const context of [
      { path: 'src/a.ts', source: 'turn', startTree: START },
      { path: 'src/a.ts', source: 'turn', endTree: END },
      { path: 'src/a.ts', source: 'turn' },
      // An empty tree reads nothing too, so it must not show as loading.
      { path: 'src/a.ts', source: 'turn', startTree: '', endTree: END },
    ] satisfies FileDiffContext[]) {
      render(context);
      expect(isTurnDiffUnavailable(context)).toBe(true);
    }
    expect(getTurnFileDiff).not.toHaveBeenCalled();
    expect(getFileDiff).not.toHaveBeenCalled();
    expect(lastResult).toEqual({ snapshot: null, error: null });
    expect(
      isTurnDiffUnavailable({
        path: 'src/a.ts',
        source: 'turn',
        startTree: START,
        endTree: END,
      }),
    ).toBe(false);
    expect(
      isTurnDiffUnavailable({ path: 'src/a.ts', source: 'combined' }),
    ).toBe(false);
  });

  it('reads the named source for a non-turn context', () => {
    render({ path: 'src/a.ts', source: 'committed' });
    expect(getFileDiff.mock.calls).toEqual([
      [
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          filePath: 'src/a.ts',
          repoId: undefined,
          source: 'committed',
        },
      ],
    ]);
  });
});
