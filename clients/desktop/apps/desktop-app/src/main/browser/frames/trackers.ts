import { randomUUID } from 'node:crypto';
import type { ControlHistory } from './model-types';

export {
  isolatedTrackerSource,
  mainWorldTrackerSource,
} from '@canopy/desktop-shared/browser/page-trackers';

export type { ControlHistory } from './model-types';

/**
 * The host side of the document-start password-history trackers (phase
 * 04b, decisions D2 to D4); their sources are in
 * `@canopy/desktop-shared/browser/page-trackers`. The host registers both
 * with `Page.addScriptToEvaluateOnNewDocument` on every session (without
 * `runImmediately`, so a tracker present in a document ran at its start);
 * the main-world one installs only in child documents, since the preload
 * installs it in every top document. These are the host's keys, the call
 * into a resolver and the decoders of its answers.
 */

/** Isolated world of the child-frame tracker. Never created by the host. */
export const TRACKER_WORLD_NAME = 'CanopyPageModelTracker';

export interface TrackerAnswer {
  /** The tracker ran at its document's start. */
  early: boolean;
  statuses: ControlHistory[];
}

export interface TrackerSummary {
  early: boolean;
  /** It remembers at least one element that was a password. */
  remembers: boolean;
}

/** A resolver key a page cannot predict. */
export function createTrackerKey(): string {
  return `__canopyPageModelTracker_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The host's call into a resolver, run with `Runtime.callFunctionOn` on an
 * execution context (so `this` is that world's global object). It uses
 * syntax only: no page-replaceable function is called on the way.
 */
export function trackerCallDeclaration(key: string, count: number): string {
  const parameters = Array.from({ length: count }, (_, index) => `e${index}`);
  const list = parameters.join(', ');
  return `function(${list}) { const resolve = this[${JSON.stringify(key)}]; return typeof resolve === 'function' ? resolve(${list}) : undefined; }`;
}

const STATUS_BY_CHARACTER: Record<string, ControlHistory> = {
  '0': 'never',
  '1': 'was',
  '2': 'unknown',
};

/**
 * Decodes a resolver's answer to a call with no element: whether it ran at
 * document start and whether it remembers any password. A late tracker
 * remembers nothing usable.
 */
export function decodeTrackerSummary(
  value: unknown,
): TrackerSummary | undefined {
  if (typeof value !== 'string' || value.length !== 2) return undefined;
  const flag = value[0];
  const remembers = value[1];
  if (
    (flag !== 'E' && flag !== 'L') ||
    (remembers !== '0' && remembers !== '1')
  )
    return undefined;
  return { early: flag === 'E', remembers: flag === 'E' && remembers === '1' };
}

/**
 * Decodes a resolver answer for `count` elements. Anything malformed is
 * undefined; a late tracker's per-element answers are all unknown.
 */
export function decodeTrackerAnswer(
  value: unknown,
  count: number,
): TrackerAnswer | undefined {
  if (count === 0) return undefined;
  if (typeof value !== 'string' || value.length !== count + 1) return undefined;
  const flag = value[0];
  if (flag !== 'E' && flag !== 'L') return undefined;
  const statuses: ControlHistory[] = [];
  for (const character of value.slice(1)) {
    const status = STATUS_BY_CHARACTER[character];
    if (status === undefined) return undefined;
    statuses.push(flag === 'E' ? status : 'unknown');
  }
  return { early: flag === 'E', statuses };
}
