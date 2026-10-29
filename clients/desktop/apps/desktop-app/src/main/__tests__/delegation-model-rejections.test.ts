import {
  clearDelegationModelRejections,
  DELEGATION_MODEL_REJECTION_TTL_MS,
  isDelegationModelRejected,
  recordDelegationModelRejection,
} from '../agents/delegation/model-rejections';

beforeEach(() => {
  clearDelegationModelRejections();
});

it('remembers a rejection per account and model until it expires', () => {
  const now = 1_000_000;
  recordDelegationModelRejection({ accountKey: 'a', modelId: 'm' }, now);
  expect(
    isDelegationModelRejected({ accountKey: 'a', modelId: 'm' }, now),
  ).toBe(true);
  expect(
    isDelegationModelRejected({ accountKey: 'b', modelId: 'm' }, now),
  ).toBe(false);
  expect(
    isDelegationModelRejected({ accountKey: 'a', modelId: 'n' }, now),
  ).toBe(false);
  expect(
    isDelegationModelRejected(
      { accountKey: 'a', modelId: 'm' },
      now + DELEGATION_MODEL_REJECTION_TTL_MS,
    ),
  ).toBe(false);
});

it('keys an unidentified account separately from identified ones', () => {
  recordDelegationModelRejection({ modelId: 'm' });
  expect(isDelegationModelRejected({ modelId: 'm' })).toBe(true);
  expect(isDelegationModelRejected({ accountKey: 'a', modelId: 'm' })).toBe(
    false,
  );
});

it('forgets the oldest rejection beyond its bound', () => {
  for (let index = 0; index <= 256; index++)
    recordDelegationModelRejection({ accountKey: 'a', modelId: `m${index}` });
  expect(isDelegationModelRejected({ accountKey: 'a', modelId: 'm0' })).toBe(
    false,
  );
  expect(isDelegationModelRejected({ accountKey: 'a', modelId: 'm256' })).toBe(
    true,
  );
});
