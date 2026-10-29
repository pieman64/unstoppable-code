/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useComposerShortcutRequests } from '../useComposerShortcutRequests';
import {
  requestEffortLevelCycle,
  type ComposerShortcutScope,
} from '@/lib/composerShortcutRequests';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const target: ComposerShortcutScope = {
  scope: 'chat',
  projectId: 'project-a',
  worktreeId: 'worktree-a',
  chatId: 'chat-a',
};

function Harness({
  enabled,
  onCycleEffort,
}: {
  enabled: boolean;
  onCycleEffort: () => void;
}): JSX.Element {
  useComposerShortcutRequests({ target, enabled, onCycleEffort });
  return <></>;
}

describe('useComposerShortcutRequests', () => {
  let container: HTMLDivElement;
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

  it('dispatches to only the enabled composer when two share one chat identity', () => {
    const primaryCycle = jest.fn<void, []>();
    const queuedEditorCycle = jest.fn<void, []>();
    act(() => {
      root.render(
        <>
          <Harness enabled onCycleEffort={primaryCycle} />
          <Harness enabled={false} onCycleEffort={queuedEditorCycle} />
        </>,
      );
    });

    let handled = false;
    act(() => {
      handled = requestEffortLevelCycle(target);
    });

    expect(handled).toBe(true);
    expect(primaryCycle).toHaveBeenCalledTimes(1);
    expect(queuedEditorCycle).not.toHaveBeenCalled();
  });
});
