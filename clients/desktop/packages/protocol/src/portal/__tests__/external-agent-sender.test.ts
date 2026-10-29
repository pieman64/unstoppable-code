import {
  externalAgentSenderSchema,
  hasOriginKey,
  parseExternalAgentSender,
} from '../external-agent-sender';

const sender = {
  kind: 'external_agent',
  connectionId: '0b9d2c4e-1f3a-4b5c-8d6e-7f8091a2b3c4',
  clientName: 'Cursor',
  verified: true,
  userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
} as const;

describe('externalAgentSenderSchema', () => {
  it('accepts the trusted sender shape', () => {
    expect(parseExternalAgentSender(sender)).toEqual(sender);
  });

  it.each([
    ['an unknown key', { ...sender, extra: 1 }],
    ['another kind', { ...sender, kind: 'user' }],
    ['an uppercase UUID', { ...sender, userId: sender.userId.toUpperCase() }],
    ['an empty client name', { ...sender, clientName: '' }],
    ['a long client name', { ...sender, clientName: 'x'.repeat(121) }],
    ['a string verified flag', { ...sender, verified: 'true' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(parseExternalAgentSender(value)).toBeNull();
    expect(externalAgentSenderSchema.safeParse(value).success).toBe(false);
  });
});

describe('hasOriginKey', () => {
  it.each([{ origin: null }, { type: 'portal.chat.send', origin: sender }])(
    'finds the envelope origin: %j',
    (value) => {
      expect(hasOriginKey(value)).toBe(true);
    },
  );

  it.each([
    { type: 'portal.chat.send', payload: { text: 'origin' } },
    { type: 'portal.pipeline.run', payload: { inputs: { origin: 'main' } } },
    { payload: { nested: { origin: 'x' } } },
    [{ origin: 1 }],
    null,
    'origin',
    42,
  ])('ignores values and payload keys: %j', (value) => {
    expect(hasOriginKey(value)).toBe(false);
  });
});
