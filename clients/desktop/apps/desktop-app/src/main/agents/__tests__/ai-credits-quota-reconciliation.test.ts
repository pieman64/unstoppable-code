import {
  canReconcileProviderQuotaReached,
  clearAllProviderQuotaReached,
  isProviderQuotaReached,
  markProviderQuotaReached,
  reconcileProviderQuotaReached,
} from '../ai-credits-quota-state';

describe('fresh subscription quota reconciliation', () => {
  afterEach(clearAllProviderQuotaReached);

  it('clears an automatic no-reset latch when a later read confirms allowance', () => {
    markProviderQuotaReached('claude');
    expect(reconcileProviderQuotaReached('claude', Date.now() + 1)).toBe(true);
    expect(isProviderQuotaReached('claude')).toBe(false);
  });

  it('retains a rejection that followed the start of an older read', () => {
    const fetchStartedAt = Date.now();
    markProviderQuotaReached('claude');
    expect(canReconcileProviderQuotaReached('claude', fetchStartedAt)).toBe(
      false,
    );
    expect(reconcileProviderQuotaReached('claude', fetchStartedAt)).toBe(false);
    expect(isProviderQuotaReached('claude')).toBe(true);
  });

  it('does not clear an unrelated provider quota', () => {
    markProviderQuotaReached('codex');
    expect(reconcileProviderQuotaReached('claude', Date.now() + 1)).toBe(true);
    expect(isProviderQuotaReached('codex')).toBe(true);
  });
});
