import type {
  DeferredToolsReloadEvent,
  DeferredToolsReloadLifecycle,
} from '@canopy/desktop-shared/types';
import { holdDispatchForDeferredReload } from '../deferred-reload-dispatch-hold';

const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

function event(
  lifecycle: DeferredToolsReloadLifecycle,
): DeferredToolsReloadEvent {
  return { scope, requestId: 'r', toolCallId: 't', lifecycle };
}

describe('holdDispatchForDeferredReload', () => {
  it('holds admission from the interruption until an outcome', () => {
    const queue = {
      holdDirectDispatch: jest.fn(),
      releaseDirectDispatchHold: jest.fn(),
    };
    for (const state of ['ui_prepared', 'interrupting', 'enabling'] as const)
      holdDispatchForDeferredReload(queue, event({ kind: 'state', state }));
    expect(queue.holdDirectDispatch.mock.calls).toEqual([[scope, 'r']]);
    expect(queue.releaseDirectDispatchHold).not.toHaveBeenCalled();

    holdDispatchForDeferredReload(
      queue,
      event({ kind: 'outcome', outcome: 'resume_failed' }),
    );
    holdDispatchForDeferredReload(
      queue,
      event({ kind: 'state', state: 'completed' }),
    );
    expect(queue.releaseDirectDispatchHold.mock.calls).toEqual([
      [scope, 'r'],
      [scope, 'r'],
    ]);
  });
});
