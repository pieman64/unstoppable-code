import {
  DelegationReadMetadataError,
  validateDelegationRecordReadMetadata,
} from '../record-read-metadata';

const record = {
  parent: { chatId: 'chat' },
  state: { delegationId: 'delegate', runGeneration: 3 },
};
const valid = {
  originAt: 10,
  lastActivityAt: 20,
  current: {
    store: 'stream',
    target: {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 3,
    },
  },
};

describe('delegation record read metadata', () => {
  it('accepts metadata matching its record and copies only known fields', () => {
    expect(
      validateDelegationRecordReadMetadata(record, {
        ...valid,
        settling: { runGeneration: 3 },
      }),
    ).toEqual({ ...valid, settling: { runGeneration: 3 } });
  });

  it.each([
    [
      'a foreign chat',
      {
        current: {
          ...valid.current,
          target: { ...valid.current.target, chatId: 'other' },
        },
      },
    ],
    [
      'another delegation',
      {
        current: {
          ...valid.current,
          target: { ...valid.current.target, delegationId: 'x' },
        },
      },
    ],
    [
      'a stale generation',
      {
        current: {
          ...valid.current,
          target: { ...valid.current.target, runGeneration: 2 },
        },
      },
    ],
    ['an unknown store', { current: { ...valid.current, store: 'inline' } }],
    ['an unknown key', { extra: true }],
    ['origin after activity', { originAt: 30 }],
    ['an unsafe timestamp', { lastActivityAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['settling another generation', { settling: { runGeneration: 2 } }],
  ])('fails closed on %s', (_label, patch) => {
    expect(() =>
      validateDelegationRecordReadMetadata(record, { ...valid, ...patch }),
    ).toThrow(DelegationReadMetadataError);
  });
});
