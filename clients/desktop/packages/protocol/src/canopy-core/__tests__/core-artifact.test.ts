import {
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  CoreArtifactListParamsSchema,
  CoreArtifactSchema,
} from '../index';

const artifact = {
  artifactId: 'att:chat:1',
  owner: { kind: 'chat', id: 'chat' },
  kind: 'attachment',
  name: 'a.png',
  mediaType: 'image/png',
  sizeBytes: 3,
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-30T10:00:00.000Z',
  availability: 'available',
  transfer: null,
};

it('registers the artifact reads as core-only queries', () => {
  for (const definition of Object.values(CORE_ARTIFACT_QUERY_DEFINITIONS))
    expect(definition).toMatchObject({
      kind: 'query',
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.artifact.read'],
    });
  expect(Object.keys(CORE_ARTIFACT_QUERY_DEFINITIONS)).toEqual([
    'core.artifact.list',
    'core.artifact.get',
  ]);
});

it('requires every list filter, as the catalog does', () => {
  const list = {
    owner: { kind: 'chat', id: 'chat' },
    kinds: [],
    states: [],
    cursor: null,
    limit: 50,
  };
  expect(CoreArtifactListParamsSchema.safeParse(list).success).toBe(true);
  expect(
    CoreArtifactListParamsSchema.safeParse({ ...list, cursor: undefined })
      .success,
  ).toBe(false);
  expect(
    CoreArtifactListParamsSchema.safeParse({
      ...list,
      owner: { kind: 'repository', id: 'r' },
    }).success,
  ).toBe(false);
});

it('closes the artifact shape and requires an offset timestamp', () => {
  expect(CoreArtifactSchema.safeParse(artifact).success).toBe(true);
  expect(
    CoreArtifactSchema.safeParse({ ...artifact, path: '/tmp/a.png' }).success,
  ).toBe(false);
  expect(
    CoreArtifactSchema.safeParse({
      ...artifact,
      createdAt: '2026-10-30 10:00',
    }).success,
  ).toBe(false);
});
