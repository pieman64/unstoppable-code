import {
  MAX_SHARED_ITEM_BATCH_SIZE,
  SHARED_ITEM_KINDS,
  isPermanentSharedItemSubscriptionError,
  isSharedItemSubscriptionBatchOversize,
  parseSharedItemInstallRemoval,
  parseSharedItemInstallUpsert,
  parseSharedItemKind,
  parseSharedItemSubscriptionBatch,
  parseSharedItemSubscriptionBatchResult,
  parseSharedItemSubscriptionItemResult,
  sharedItemSubscriptionKey,
  type SharedItemInstallRemoval,
  type SharedItemInstallUpsert,
} from '..';

const removal: SharedItemInstallRemoval = {
  kind: 'skill',
  remoteId: 'skill-ext-1',
  sourceKind: 'shared',
  sourceKey: 'desktop:device-1',
};
const upsert: SharedItemInstallUpsert = { ...removal, contentHash: 'abc123' };

describe('shared item subscription wire contract', () => {
  it('pins the shareable kinds', () => {
    expect(SHARED_ITEM_KINDS).toEqual([
      'skill',
      'pipeline',
      'automation',
      'collection',
      'agent',
      'workspace-template',
    ]);
  });

  it('parses kinds strictly', () => {
    expect(parseSharedItemKind('workspace-template')).toBe(
      'workspace-template',
    );
    expect(parseSharedItemKind('plugin')).toBeNull();
    expect(parseSharedItemKind(undefined)).toBeNull();
  });

  describe('parseSharedItemInstallUpsert', () => {
    it('accepts a valid upsert with a hash or a null hash', () => {
      expect(parseSharedItemInstallUpsert(upsert)).toEqual(upsert);
      expect(
        parseSharedItemInstallUpsert({ ...upsert, contentHash: null }),
      ).toEqual({ ...upsert, contentHash: null });
      expect(
        parseSharedItemInstallUpsert({
          ...upsert,
          sourceKey: 'cloud:3f0a8c2e-1b2c-4d5e-8f90-123456789abc',
        }),
      ).not.toBeNull();
    });

    it.each([
      ['missing contentHash', removal],
      ['extra field', { ...upsert, extra: true }],
      ['unknown kind', { ...upsert, kind: 'plugin' }],
      ['unknown source kind', { ...upsert, sourceKind: 'curated' }],
      ['empty remoteId', { ...upsert, remoteId: '' }],
      ['numeric remoteId', { ...upsert, remoteId: 12 }],
      ['empty hash', { ...upsert, contentHash: '' }],
      ['numeric hash', { ...upsert, contentHash: 1 }],
      ['bad source key prefix', { ...upsert, sourceKey: 'mobile:x' }],
      ['source key with spaces', { ...upsert, sourceKey: 'desktop:a b' }],
      [
        'oversize source key',
        { ...upsert, sourceKey: `desktop:${'a'.repeat(128)}` },
      ],
    ])('rejects %s', (_label, value) => {
      expect(parseSharedItemInstallUpsert(value)).toBeNull();
    });
  });

  describe('parseSharedItemInstallRemoval', () => {
    it('accepts a valid removal', () => {
      expect(parseSharedItemInstallRemoval(removal)).toEqual(removal);
    });

    it.each([
      ['extra contentHash', upsert],
      ['undefined sourceKey', { ...removal, sourceKey: undefined }],
      [
        'absent sourceKey',
        {
          kind: removal.kind,
          remoteId: removal.remoteId,
          sourceKind: removal.sourceKind,
        },
      ],
      ['wrong-typed sourceKind', { ...removal, sourceKind: 1 }],
    ])('rejects %s', (_label, value) => {
      expect(parseSharedItemInstallRemoval(value)).toBeNull();
    });
  });

  describe('parseSharedItemSubscriptionBatch', () => {
    it('accepts a valid batch', () => {
      expect(
        parseSharedItemSubscriptionBatch({
          upserts: [upsert],
          removals: [removal],
        }),
      ).toEqual({ upserts: [upsert], removals: [removal] });
    });

    it.each([
      ['missing removals', { upserts: [] }],
      ['extra field', { upserts: [], removals: [], more: [] }],
      ['non-array upserts', { upserts: {}, removals: [] }],
      ['malformed entry', { upserts: [removal], removals: [] }],
    ])('rejects %s', (_label, value) => {
      expect(parseSharedItemSubscriptionBatch(value)).toBeNull();
    });

    it('flags batches over the size limit without rejecting them in the parser', () => {
      const batch = parseSharedItemSubscriptionBatch({
        upserts: Array.from(
          { length: MAX_SHARED_ITEM_BATCH_SIZE },
          () => upsert,
        ),
        removals: [removal],
      });
      expect(batch).not.toBeNull();
      expect(batch && isSharedItemSubscriptionBatchOversize(batch)).toBe(true);
      expect(
        isSharedItemSubscriptionBatchOversize({
          upserts: [upsert],
          removals: [],
        }),
      ).toBe(false);
    });
  });

  describe('results', () => {
    it('parses item results strictly', () => {
      expect(parseSharedItemSubscriptionItemResult({ ok: true })).toEqual({
        ok: true,
      });
      expect(
        parseSharedItemSubscriptionItemResult({ ok: false, code: 'forbidden' }),
      ).toEqual({ ok: false, code: 'forbidden' });
      expect(
        parseSharedItemSubscriptionItemResult({ ok: false, code: 'nope' }),
      ).toBeNull();
      expect(
        parseSharedItemSubscriptionItemResult({ ok: true, code: 'error' }),
      ).toBeNull();
      expect(parseSharedItemSubscriptionItemResult({ ok: false })).toBeNull();
      expect(
        parseSharedItemSubscriptionItemResult({
          ok: false,
          code: 'error',
          detail: 'x',
        }),
      ).toBeNull();
    });

    it('parses a batch result', () => {
      expect(
        parseSharedItemSubscriptionBatchResult({
          upserts: [{ ok: true }],
          removals: [{ ok: false, code: 'error' }],
        }),
      ).toEqual({
        upserts: [{ ok: true }],
        removals: [{ ok: false, code: 'error' }],
      });
      expect(
        parseSharedItemSubscriptionBatchResult({
          upserts: [{ ok: 1 }],
          removals: [],
        }),
      ).toBeNull();
      expect(
        parseSharedItemSubscriptionBatchResult({ upserts: [{ ok: true }] }),
      ).toBeNull();
      expect(
        parseSharedItemSubscriptionBatchResult({
          upserts: [],
          removals: [],
          extra: [],
        }),
      ).toBeNull();
    });

    it('treats only the generic error code as transient', () => {
      expect(isPermanentSharedItemSubscriptionError('not-found')).toBe(true);
      expect(isPermanentSharedItemSubscriptionError('forbidden')).toBe(true);
      expect(isPermanentSharedItemSubscriptionError('invalid')).toBe(true);
      expect(isPermanentSharedItemSubscriptionError('error')).toBe(false);
    });
  });

  it('builds the desktop ledger key', () => {
    expect(
      sharedItemSubscriptionKey({
        kind: 'automation',
        sourceKind: 'public',
        remoteId: 'r1',
      }),
    ).toBe('automation:public:r1');
  });
});
