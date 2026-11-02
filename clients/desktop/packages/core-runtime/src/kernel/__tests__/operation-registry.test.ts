import {
  CanopyErrorPayloadSchema,
  CanopyRequestMetadataSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '@canopy/protocol/canopy-core';
import {
  createOperationRegistry,
  type OperationRegistryOptions,
} from '../operation-registry';

const shared = {
  domain: 'example',
  version: 1,
  placement: 'core-only',
  requiredGrants: ['core.example.read'],
  params: CanopyStreamCursorSchema,
  error: CanopyErrorPayloadSchema,
} as const;
const queries = defineCanopyQueryRegistry('core', {
  'core.example.read': defineCanopyQuery({
    ...shared,
    plane: 'core',
    idempotency: 'inherent',
    result: CanopyStreamCursorSchema,
  }),
});
const instructions = defineCanopyInstructionRegistry('core', {
  'core.example.write': defineCanopyInstruction({
    ...shared,
    plane: 'core',
    idempotency: 'keyed',
    params: CanopyStreamCursorSchema.extend({
      _meta: CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
    }),
    result: CanopyStreamCursorSchema,
  }),
});
const streams = defineCanopyStreamRegistry('core', {
  'core.example.events': defineCanopyStream({
    ...shared,
    plane: 'core',
    idempotency: 'inherent',
    params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).extend({
      cursor: CanopyStreamCursorSchema.nullable().optional(),
    }),
    item: CanopyStreamCursorSchema,
    end: CanopyStreamEndSchema,
  }),
});
const owners = [
  { name: 'a', operations: ['core.example.read', 'core.example.write'] },
  { name: 'b', operations: ['core.example.events'] },
];

function build(
  overrides: Partial<OperationRegistryOptions> = {},
): ReturnType<typeof createOperationRegistry> {
  return createOperationRegistry({
    profile: 'core',
    definitions: { queries, instructions, streams },
    owners,
    ...overrides,
  });
}

describe('createOperationRegistry', () => {
  it('rejects a module whose tag conflicts with the profile or operations', () => {
    const tagged = owners.map((owner) => ({
      ...owner,
      plane: 'worker' as const,
    }));
    expect(() => build({ owners: tagged })).toThrow(
      'cannot host worker module',
    );
    expect(() => build({ profile: 'core+worker', owners: tagged })).toThrow(
      'cannot register core operation',
    );
  });
  it('returns frozen metadata for every definition with its owner', () => {
    const registry = build();
    expect(registry).toEqual([
      {
        name: 'core.example.read',
        kind: 'query',
        plane: 'core',
        owner: 'a',
        declaresMeta: false,
      },
      {
        name: 'core.example.write',
        kind: 'instruction',
        plane: 'core',
        owner: 'a',
        declaresMeta: true,
      },
      {
        name: 'core.example.events',
        kind: 'stream',
        plane: 'core',
        owner: 'b',
        declaresMeta: false,
      },
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(registry.every((operation) => Object.isFrozen(operation))).toBe(
      true,
    );
  });

  it('accepts a single bundle owner and a core+worker profile', () => {
    const bundle = [
      { name: 'bundle', operations: owners.flatMap((o) => o.operations) },
    ];
    expect(build({ profile: 'core+worker', owners: bundle })).toHaveLength(3);
  });

  it('rejects definitions whose plane the profile cannot host', () => {
    expect(() => build({ profile: 'worker' })).toThrow(
      'Runtime profile worker cannot register operation core.example.read',
    );
  });

  it('rejects names duplicated across kinds', () => {
    expect(() =>
      build({
        definitions: {
          queries,
          instructions: {
            'core.example.read': instructions['core.example.write'],
          },
          streams,
        },
      }),
    ).toThrow('Duplicate operation name core.example.read');
  });

  it.each([
    [
      'duplicate owner names',
      [...owners, { name: 'a', operations: [] }],
      'Duplicate operation owner a',
    ],
    [
      'double claims',
      [...owners, { name: 'c', operations: ['core.example.events'] }],
      'Operation core.example.events is claimed by both b and c',
    ],
    [
      'unknown operations',
      [...owners, { name: 'c', operations: ['core.example.missing'] }],
      'Owner c claims unknown operation core.example.missing',
    ],
    [
      'unclaimed definitions',
      owners.slice(0, 1),
      'Operation core.example.events has no owner',
    ],
  ])('rejects %s', (_label, badOwners, message) => {
    expect(() => build({ owners: badOwners })).toThrow(message);
  });
});
