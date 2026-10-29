import { hostWorldContext, type ActionTargetDeps } from './action-targets';
import { evaluateLocator, isInvalidSelectorError } from './locators';
import type { NodeIdentity } from './frame-registry';
import { remoteValue } from './host-cdp';
import {
  LocatorRequestError,
  matchLocator,
  resolveFrameScope,
} from './locator-requests';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from './model-types';

/** A `wait_for` condition on elements: a locator or text. */
export interface WaitProbeRequest {
  locator?: string;
  text?: string;
  /** A frameRef or an iframe CSS selector that scopes the locator or text. */
  frame?: string;
}

export type DocumentReadyState = 'loading' | 'interactive' | 'complete';

/**
 * The deleted preload `isVisibleElement` rule on a captured node: a non-empty box,
 * not `display: none`, not `visibility: hidden` or `collapse`.
 */
function isVisibleNode(node: PageModelNode): boolean {
  if (node.styleUnknown === true) return false;
  const display = node.computedStyles.display?.toLowerCase();
  const visibility = node.computedStyles.visibility?.toLowerCase();
  return (
    node.bounds.width > 0 &&
    node.bounds.height > 0 &&
    display !== 'none' &&
    visibility !== 'hidden' &&
    visibility !== 'collapse'
  );
}

/**
 * Matches a `wait_for` locator (`allMatches`, invalid CSS rejected) or text
 * (`textLocatorMatches`) in every frame of the model, and counts the
 * visible ones. Throws `LocatorRequestError` for an invalid or unsupported
 * locator.
 */
export async function probeMatches(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  request: WaitProbeRequest,
): Promise<{ matchCount: number; visibleCount: number }> {
  const frames = await waitFrames(deps, model, request.frame);
  let matches: NodeIdentity[] = [];
  if (request.locator !== undefined) {
    matches = await matchLocator(model, deps, request.locator, frames, 'wait');
  } else if (request.text !== undefined) {
    matches = await evaluateLocator(
      model,
      deps,
      { kind: 'text', value: request.text },
      { frames },
    );
  }
  let visibleCount = 0;
  for (const identity of matches) {
    const node = model.nodes.find(
      (candidate) =>
        candidate.identity.sessionId === identity.sessionId &&
        candidate.identity.backendNodeId === identity.backendNodeId,
    );
    if (node && isVisibleNode(node)) visibleCount += 1;
  }
  return { matchCount: matches.length, visibleCount };
}

/**
 * The frames a wait looks in. A frame that is missing (not loaded yet, or
 * gone) has no matches, so the wait keeps polling or, for `detached`, is
 * satisfied; an unparsable selector is an invalid target, as for the
 * locator.
 */
async function waitFrames(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  frame: string | undefined,
): Promise<PageModelFrame[]> {
  if (frame === undefined) return model.frames;
  try {
    return (
      (await resolveFrameScope(model, deps, frame, { strict: true })) ?? []
    );
  } catch (error) {
    if (isInvalidSelectorError(error)) {
      throw new LocatorRequestError(
        'invalid_css',
        `Invalid CSS locator ${JSON.stringify(frame)}: the frame selector could not be parsed.`,
      );
    }
    throw error;
  }
}

function decodeReadyState(value: unknown): DocumentReadyState | undefined {
  return value === 'loading' || value === 'interactive' || value === 'complete'
    ? value
    : undefined;
}

/** The top document's `readyState`, read in its host world. */
export async function readTopReadyState(
  deps: ActionTargetDeps,
): Promise<DocumentReadyState> {
  const root = deps.registry
    .frames()
    .find((frame) => frame.sessionId === '' && frame.parentId === undefined);
  if (!root) throw new Error('The page has no document yet.');
  const read = async (
    contextId: number,
  ): Promise<DocumentReadyState | undefined> =>
    decodeReadyState(
      remoteValue(
        await deps
          .send(
            'Runtime.evaluate',
            {
              expression: 'document.readyState',
              contextId,
              returnByValue: true,
            },
            '',
          )
          .catch(() => undefined),
      ),
    );
  const existing = await hostWorldContext(deps, root.frameId, '');
  let state = existing === undefined ? undefined : await read(existing);
  if (state === undefined) {
    const fresh = await hostWorldContext(deps, root.frameId, '', true);
    state =
      fresh === undefined || fresh === existing ? undefined : await read(fresh);
  }
  if (state === undefined) {
    throw new Error('The page document could not be read.');
  }
  return state;
}
