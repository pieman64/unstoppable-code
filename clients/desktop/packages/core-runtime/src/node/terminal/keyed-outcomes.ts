import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';
import type { CanopyHandlerContext } from '../../runtime/types';

export class KeyedOutcomes<T> {
  private readonly outcomes = new Map<
    string,
    { fingerprint: string; outcome: Promise<T> }
  >();

  public constructor(
    private readonly reused: () => Error,
    private readonly max = 256,
  ) {}

  run(
    context: CanopyHandlerContext,
    params: unknown,
    start: () => Promise<T>,
  ): Promise<T> {
    const key = context.metadata.idempotencyKey;
    if (key === undefined) return start();
    const id = `${context.caller.principalId}\0${context.caller.clientInstanceId}\0${key}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(params) ?? 'null')
      .digest('hex');
    const existing = this.outcomes.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(this.reused());
      return existing.outcome;
    }
    const outcome = start();
    this.outcomes.set(id, { fingerprint, outcome });
    outcome.catch(() => {
      // A failed attempt may be retried with the same key.
      if (this.outcomes.get(id)?.outcome === outcome) this.outcomes.delete(id);
    });
    while (this.outcomes.size > this.max) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return outcome;
  }
}
