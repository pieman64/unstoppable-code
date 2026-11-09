import type {
  BrowserActionErrorCode,
  BrowserAutomationCommand,
  BrowserJavaScriptDialog,
} from '@canopy/execution-engine/types/browser';
import type {
  ActionTargetRequest,
  ActionTargetResolution,
  ResolvedActionTarget,
} from '../frames/action-targets';
import type { ActionLaneContext } from './action-lane';

/** What the action resolves its target with (the page model host). */
export interface ActionTargetHost {
  resolveActionTarget(
    request: ActionTargetRequest,
  ): Promise<ActionTargetResolution>;
  releaseActionTarget(target: ResolvedActionTarget): Promise<void>;
}

/** The target could not be resolved; `code` is the receipt's error code. */
export class TargetResolutionError extends Error {
  constructor(
    readonly code: Extract<
      BrowserActionErrorCode,
      | 'target_stale'
      | 'target_not_found'
      | 'target_ambiguous'
      | 'frame_unavailable'
      | 'execution_failed'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

/** A dialog opened while the target was being resolved. */
export class TargetDialogError extends Error {
  constructor(readonly dialog: BrowserJavaScriptDialog) {
    super('A JavaScript dialog opened while resolving the target.');
    this.name = 'TargetDialogError';
  }
}

/**
 * The target fields of an input command, as phase 03 reads them: a ref
 * first, then a locator (scoped by `frame`), then click coordinates, and
 * for a press without a target the focused element. Undefined when the
 * command names no target.
 */
export function actionTargetRequest(
  command: Exclude<BrowserAutomationCommand, { kind: 'inspect' | 'wait_for' }>,
): ActionTargetRequest | undefined {
  if (command.kind === 'drag') {
    return command.from.ref !== undefined
      ? { kind: 'ref', ref: command.from.ref }
      : {
          kind: 'locator',
          locator: command.from.locator,
          frame: command.from.frame,
        };
  }
  if (command.kind === 'scroll' && command.toText !== undefined)
    return { kind: 'text', text: command.toText, frame: command.frame };
  if (
    command.kind === 'scroll' &&
    command.direction !== undefined &&
    command.ref === undefined &&
    command.locator === undefined
  )
    return { kind: 'page' };
  if (command.ref !== undefined) return { kind: 'ref', ref: command.ref };
  if (command.locator !== undefined)
    return {
      kind: 'locator',
      locator: command.locator,
      ...(command.frame === undefined ? {} : { frame: command.frame }),
    };
  if (
    (command.kind === 'click' || command.kind === 'hover') &&
    command.x !== undefined &&
    command.y !== undefined
  )
    return { kind: 'point', x: command.x, y: command.y };
  if (command.kind === 'press' || command.kind === 'type')
    return { kind: 'focused' };
  return undefined;
}

function resolutionError(
  resolution: Exclude<ActionTargetResolution, { status: 'found' }>,
): TargetResolutionError {
  return new TargetResolutionError(
    resolution.status === 'invalid_locator'
      ? 'execution_failed'
      : resolution.status,
    resolution.message,
  );
}

/**
 * Resolves an action's target once, before actionability (D7), keeping
 * the prepared-target guarantees: its release is registered in the lane
 * before anything can throw; a dialog that opens while resolving fails the
 * action; a target that resolves after the action was cancelled or
 * abandoned is released when it arrives; and the retained object is
 * released exactly once, in the lane's cleanup.
 */
export async function holdActionTarget(options: {
  host: ActionTargetHost;
  request: ActionTargetRequest;
  lane: ActionLaneContext;
  /** Whether the action passed its dispatch boundary (releases are tracked). */
  isDispatched: () => boolean;
  /** Calls the listener for a dialog that is or becomes pending; unsubscribes. */
  watchDialogs: (
    listener: (dialog: BrowserJavaScriptDialog) => void,
  ) => () => void;
}): Promise<ResolvedActionTarget> {
  const { host, lane } = options;
  let held: ResolvedActionTarget | undefined;
  let released = false;
  let abandoned = false;
  const release = async (): Promise<void> => {
    if (!held || released) return;
    released = true;
    const completion = host.releaseActionTarget(held);
    await (options.isDispatched() ? lane.trackCommand(completion) : completion);
  };
  lane.registerCleanup(async (): Promise<void> => {
    abandoned = true;
    await release();
  });
  const resolution = Promise.resolve().then(() =>
    host.resolveActionTarget(options.request),
  );
  void resolution.then(
    async (result): Promise<void> => {
      if (result.status !== 'found') return;
      held = result.target;
      if (lane.signal.aborted || abandoned)
        await release().catch(() => undefined);
    },
    (): void => {},
  );
  let unsubscribe = (): void => {};
  const dialogWhileResolving = new Promise<never>((_resolve, reject) => {
    unsubscribe = options.watchDialogs((dialog) =>
      reject(new TargetDialogError(dialog)),
    );
  });
  let result: ActionTargetResolution;
  try {
    result = await Promise.race([resolution, dialogWhileResolving]);
  } finally {
    unsubscribe();
  }
  lane.signal.throwIfAborted();
  if (result.status !== 'found') throw resolutionError(result);
  held = result.target;
  return result.target;
}

/**
 * The receipt message for an unresolved target: phase 03's default for
 * stale and missing targets (undefined), and the model's, which names
 * frames, for the rest.
 */
export function resolutionMessage(
  error: TargetResolutionError,
): string | undefined {
  if (error.code === 'target_ambiguous')
    return `${error.message} Use a current input reference or the frame field.`;
  if (error.code === 'frame_unavailable')
    return `${error.message} Refresh the input snapshot.`;
  if (error.code === 'execution_failed') return error.message;
  return undefined;
}
