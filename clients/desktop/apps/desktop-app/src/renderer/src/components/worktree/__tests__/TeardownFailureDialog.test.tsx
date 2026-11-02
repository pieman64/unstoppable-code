/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TeardownFailedError } from '@/stores/projectsStore';
import { TeardownFailureDialog } from '../TeardownFailureDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// CAN-5336: the only forced worktree action is the discard; this one only
// skips teardown, and its label says so in the removal's own mode.
describe('TeardownFailureDialog', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    [undefined, 'Delete without teardown'],
    [false, 'Delete without teardown'],
    [true, 'Archive without teardown'],
  ] as const)(
    'labels the skip-teardown action for lockAfterArchive %s as %s',
    (lockAfterArchive, label) => {
      const error = new TeardownFailedError({
        projectId: 'p',
        worktreeId: 'w',
        output: '',
        timedOut: false,
      });
      error.lockAfterArchive = lockAfterArchive;
      const onSkipTeardown = jest.fn();
      act(() =>
        root.render(
          <TeardownFailureDialog
            error={error}
            onRetry={jest.fn()}
            onSkipTeardown={onSkipTeardown}
            onCancel={jest.fn()}
          />,
        ),
      );
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      );
      expect(buttons.map((button) => button.textContent)).not.toContain(
        'Force delete',
      );
      const action = buttons.find((button) => button.textContent === label);
      expect(action).toBeDefined();
      act(() => action?.click());
      expect(onSkipTeardown).toHaveBeenCalledTimes(1);
    },
  );
});
