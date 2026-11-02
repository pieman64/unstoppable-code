import { ledgerViewScopeKey } from '../index';

const ORG_ID = '0b4f8a52-7c1d-4e8a-9f3b-2d6c1e5a7b90';

describe('view scope keys', () => {
  it('never lets two task scopes share a key', () => {
    expect(ledgerViewScopeKey({ projectId: 'a:b', worktreeId: 'c' })).not.toBe(
      ledgerViewScopeKey({ projectId: 'a', worktreeId: 'b:c' }),
    );
  });

  it('keys a global scope by its owner and its ledger', () => {
    const ledgerId = '11111111-2222-4333-8444-555555555555';
    const personal = ledgerViewScopeKey({
      kind: 'global',
      owner: { kind: 'personal' },
      ledgerId,
    });

    expect(personal).not.toBe(
      ledgerViewScopeKey({
        kind: 'global',
        owner: { kind: 'organization', organizationId: ORG_ID },
        ledgerId,
      }),
    );
    expect(personal).not.toBe(
      ledgerViewScopeKey({
        kind: 'global',
        owner: { kind: 'personal' },
        ledgerId: '66666666-7777-4888-9999-000000000000',
      }),
    );
  });
});
