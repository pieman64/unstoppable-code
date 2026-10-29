import {
  canPurgeLedgerScope,
  canRebindLedgerScope,
  canTransitionLedgerScope,
  isLedgerScopeLifecycleState,
  isLedgerScopeWritable,
  ledgerScopeLifecycleRejection,
  ledgerScopeLifecycleStep,
  type LedgerScopeLifecycleStep,
  type LedgerScopeLifecycleTarget,
} from '../lifecycle';
import {
  LEDGER_SCOPE_LIFECYCLE_STATES,
  type LedgerScopeLifecycleState,
} from '../types';

describe('Ledger scope lifecycle', () => {
  // Every state against every target, including removal.
  it.each<
    [
      LedgerScopeLifecycleState,
      LedgerScopeLifecycleTarget,
      LedgerScopeLifecycleStep,
    ]
  >([
    ['active', 'active', 'unchanged'],
    ['active', 'archived', 'transition'],
    ['active', 'retirement_pending', 'transition'],
    ['active', 'purged', 'forbidden'],
    ['archived', 'active', 'transition'],
    ['archived', 'archived', 'unchanged'],
    ['archived', 'retirement_pending', 'transition'],
    ['archived', 'purged', 'forbidden'],
    ['retirement_pending', 'active', 'forbidden'],
    ['retirement_pending', 'archived', 'forbidden'],
    ['retirement_pending', 'retirement_pending', 'unchanged'],
    ['retirement_pending', 'purged', 'transition'],
  ])('%s → %s is %s', (from, to, step) => {
    expect(ledgerScopeLifecycleStep(from, to)).toBe(step);
    expect(canTransitionLedgerScope(from, to)).toBe(step !== 'forbidden');
  });

  it('accepts writes only in active scopes', () => {
    expect(
      LEDGER_SCOPE_LIFECYCLE_STATES.filter((state) =>
        isLedgerScopeWritable(state),
      ),
    ).toEqual(['active']);
  });

  it('rebinds only archived scopes and purges only retiring ones', () => {
    expect(
      LEDGER_SCOPE_LIFECYCLE_STATES.filter((state) =>
        canRebindLedgerScope(state),
      ),
    ).toEqual(['archived']);
    expect(
      LEDGER_SCOPE_LIFECYCLE_STATES.filter((state) =>
        canPurgeLedgerScope(state),
      ),
    ).toEqual(['retirement_pending']);
  });

  it('refuses a retiring scope as retired and a live scope as forbidden', () => {
    expect(ledgerScopeLifecycleRejection('retirement_pending')).toBe(
      'SCOPE_RETIRED',
    );
    expect(ledgerScopeLifecycleRejection('active')).toBe('FORBIDDEN');
    expect(ledgerScopeLifecycleRejection('archived')).toBe('FORBIDDEN');
  });

  it('recognizes only the stored lifecycle states', () => {
    for (const state of LEDGER_SCOPE_LIFECYCLE_STATES) {
      expect(isLedgerScopeLifecycleState(state)).toBe(true);
    }
    for (const value of ['purged', 'deleted', 'Active', '', null, 1]) {
      expect(isLedgerScopeLifecycleState(value)).toBe(false);
    }
  });
});
