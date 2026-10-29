/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  SubagentChangesDialog,
  type SubagentChangesTarget,
} from '../SubagentChangesDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const target: SubagentChangesTarget = {
  scope: { projectId: 'project-1', worktreeId: 'worktree-1' },
  delegationId: 'delegate-1',
  revision: 'abc1234',
  title: 'Review tests',
};

function Harness({
  visible,
}: {
  readonly visible: boolean;
}): JSX.Element | null {
  return visible ? (
    <SubagentChangesDialog target={target} onClose={(): void => {}} />
  ) : null;
}

describe('SubagentChangesDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads and displays the isolated delegate changes', async () => {
    const changes = jest.fn().mockResolvedValue({
      ok: true,
      changes: {
        files: [
          {
            path: 'src/a.ts',
            change: 'modified',
            diff: '@@ -1 +1 @@\n-old\n+new',
            diffTruncated: true,
          },
        ],
        omittedFiles: 1,
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { changes } },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness visible />);
      await Promise.resolve();
    });

    expect(changes).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      delegationId: 'delegate-1',
      revision: 'abc1234',
    });
    expect(document.body.textContent).toContain('Changes from Review tests');
    expect(document.body.textContent).toContain('src/a.ts');
    expect(document.body.textContent).toContain('Showing first 1 file');
    expect(document.body.textContent).toContain('Diff shortened to fit');
    // Diff content stays out of session replay; the dialog is portaled
    // outside any blocked ancestor.
    const diff = Array.from(document.body.querySelectorAll('pre')).find(
      (element) => element.textContent?.includes('+new'),
    );
    expect(diff?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);

    act((): void => root.unmount());
  });

  it('offers retry after a read failure', async () => {
    const changes = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Checkout missing.' })
      .mockResolvedValueOnce({ ok: true, changes: { files: [] } });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { managedDelegation: { changes } },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness visible />);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Couldn't read the delegate's changes.",
    );

    const retry = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[data-testid="subagent-changes-dialog"] button',
      ),
    ).find((button) => button.textContent === 'Try again');
    if (!retry) throw new Error('retry action was not rendered');
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(changes).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "No changes in the delegate's worktree",
    );

    act((): void => root.unmount());
  });
});
