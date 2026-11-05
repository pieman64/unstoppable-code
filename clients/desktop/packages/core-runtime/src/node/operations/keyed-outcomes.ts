import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';
import type { CanopyHandlerContext } from '../../runtime/types';

/** Keyed outcomes this worker keeps for replay; the oldest are dropped. */
export const MAX_KEYED_OUTCOMES = 512;

/**
 * Keyed replay for this worker's instructions: a repeat with the same caller,
 * key and parameters returns the first outcome, joining it while it runs,
 * instead of running the script again; other parameters are refused. Kept in
 * memory: across a restart the core's dispatch record resolves the outcome.
 */
export class KeyedOutcomes<T> {
  constructor(
    private readonly options: { reusedError: () => Error; max?: number },
  ) {}

  private readonly outcomes = new Map<
    string,
    { fingerprint: string; outcome: Promise<T> }
  >();

  run(
    context: CanopyHandlerContext,
    params: unknown,
    start: () => Promise<T>,
  ): Promise<T> {
    const key = context.metadata.idempotencyKey;
    if (key === undefined) return start();
    const id = `${context.caller.principalId}\0${key}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(params) ?? 'null')
      .digest('hex');
    const existing = this.outcomes.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(this.options.reusedError());
      return existing.outcome;
    }
    const outcome = start();
    this.outcomes.set(id, { fingerprint, outcome });
    outcome.catch(() => undefined);
    while (this.outcomes.size > (this.options.max ?? MAX_KEYED_OUTCOMES)) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return outcome;
  }
}
