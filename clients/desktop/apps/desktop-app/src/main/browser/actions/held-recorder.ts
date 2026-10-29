import type { InputRecorder } from '../frames/input-recorder';
import type { ActionLaneContext } from './action-lane';

/**
 * Arms a frame target's input recorder for one action, held the way
 * `holdActionTarget` holds the target (review R2 finding 2): its disposal
 * is registered in the lane before the arm starts, a recorder that arrives
 * after the action was cancelled or abandoned is disposed when it arrives,
 * and it is disposed exactly once.
 */
export async function holdInputRecorder(options: {
  arm: () => Promise<InputRecorder | undefined>;
  lane: ActionLaneContext;
  /** Whether the action passed its dispatch boundary (disposal is tracked). */
  isDispatched: () => boolean;
}): Promise<InputRecorder | undefined> {
  const { lane } = options;
  let held: InputRecorder | undefined;
  let abandoned = false;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (!held || disposed) return;
    disposed = true;
    const completion = held.dispose();
    await (options.isDispatched() ? lane.trackCommand(completion) : completion);
  };
  lane.registerCleanup(async (): Promise<void> => {
    abandoned = true;
    await dispose();
  });
  const arming = Promise.resolve()
    .then(() => options.arm())
    .catch(() => undefined);
  void arming.then(async (recorder): Promise<void> => {
    if (!recorder) return;
    held = recorder;
    if (lane.signal.aborted || abandoned)
      await dispose().catch(() => undefined);
  });
  const recorder = await arming;
  held = recorder;
  return recorder;
}
