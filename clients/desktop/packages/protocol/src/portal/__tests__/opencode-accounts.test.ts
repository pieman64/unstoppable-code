import {
  openCodeAccountMetadataSchema,
  openCodeAccountSnapshotSchema,
} from '../opencode-accounts';

const provider = {
  id: 'fixture',
  name: 'Fixture',
  accounts: [
    { label: 'Work', method: 'oauth', selected: true, needsSignIn: false },
  ],
};

it('projects display fields and drops credential values, raw status and provider configuration', () => {
  const result = openCodeAccountMetadataSchema.parse({
    providers: [
      {
        ...provider,
        headers: { authorization: 'secret-header' },
        accounts: [
          {
            ...provider.accounts[0],
            token: 'secret-token',
            status: { message: 'secret-error' },
          },
        ],
      },
    ],
    credentials: 'secret-credential',
  });
  expect(result).toEqual({ providers: [provider] });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('rejects duplicated providers and malformed or oversized account metadata', () => {
  for (const value of [
    { providers: [provider, provider] },
    {
      providers: [
        {
          ...provider,
          accounts: [{ ...provider.accounts[0], method: 'token' }],
        },
      ],
    },
    {
      providers: [
        {
          ...provider,
          accounts: [{ ...provider.accounts[0], label: 'a'.repeat(321) }],
        },
      ],
    },
    {
      providers: [
        {
          ...provider,
          accounts: Array.from({ length: 51 }, () => provider.accounts[0]),
        },
      ],
    },
    {
      providers: Array.from({ length: 51 }, (_, index) => ({
        ...provider,
        id: `provider-${index}`,
      })),
    },
    {
      providers: Array.from({ length: 5 }, (_, index) => ({
        ...provider,
        id: `provider-${index}`,
        accounts: Array.from({ length: 50 }, () => provider.accounts[0]),
      })),
    },
  ])
    expect(openCodeAccountMetadataSchema.safeParse(value).success).toBe(false);
});

it('an unavailable snapshot cannot retain account labels', () => {
  expect(
    openCodeAccountSnapshotSchema.safeParse({
      status: 'unavailable',
      updatedAt: '2026-10-21T23:00:00Z',
      providers: [provider],
    }).success,
  ).toBe(false);
});
