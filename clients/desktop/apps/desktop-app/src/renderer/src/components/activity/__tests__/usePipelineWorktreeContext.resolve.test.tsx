/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePipelineWorktreeContext } from '../usePipelineWorktreeContext';

type Context = ReturnType<typeof usePipelineWorktreeContext>;

function Probe({
  projectId,
  worktreeId,
  seen,
}: {
  projectId: string | undefined;
  worktreeId: string | undefined;
  seen: Context[];
}): JSX.Element | null {
  seen.push(usePipelineWorktreeContext(projectId, worktreeId));
  return null;
}

describe('usePipelineWorktreeContext cwdResolved', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resolvePath: (path: string) => void = () => undefined;

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getWorktreePath: jest.fn(
          () =>
            new Promise<string>((resolve) => {
              resolvePath = resolve;
            }),
        ),
        listWorktreeRepoEntries: jest.fn().mockResolvedValue([]),
      },
    });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it('is resolved with no task', () => {
    const seen: Context[] = [];
    act(() => {
      root.render(
        <Probe projectId={undefined} worktreeId={undefined} seen={seen} />,
      );
    });
    expect(seen.at(-1)).toMatchObject({ cwd: undefined, cwdResolved: true });
  });

  it("waits for the task's folder before it is resolved", async () => {
    const seen: Context[] = [];
    act(() => {
      root.render(<Probe projectId="p" worktreeId="w" seen={seen} />);
    });
    expect(seen.at(-1)).toMatchObject({ cwd: undefined, cwdResolved: false });

    await act(async () => {
      resolvePath('/w');
      await Promise.resolve();
    });
    expect(seen.at(-1)).toMatchObject({ cwd: '/w', cwdResolved: true });
  });
});
