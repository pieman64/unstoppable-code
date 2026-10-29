import { classifyPersistedWorkspaceOwner, normalizeUuid } from '..';

const ORG = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INSTANCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const binding = {
  type: 'organization',
  organizationId: ORG,
  projectId: PROJECT,
  instanceId: INSTANCE,
  bindingGeneration: 0,
};

it('classifies an absent owner as Personal', () => {
  expect(classifyPersistedWorkspaceOwner(undefined)).toEqual({
    kind: 'personal',
  });
});

it('accepts trimmed or upper-case UUID bindings and lower-cases them', () => {
  expect(
    classifyPersistedWorkspaceOwner({
      ...binding,
      organizationId: ` ${ORG} `,
      bindingGeneration: 3,
      future: true,
    }),
  ).toEqual({
    kind: 'organization',
    owner: {
      type: 'organization',
      organizationId: ORG.toLowerCase(),
      projectId: PROJECT,
      instanceId: INSTANCE,
      bindingGeneration: 3,
    },
  });
});

it.each([
  ['null', null],
  ['an empty object', {}],
  ['a user owner', { type: 'user' }],
  ['a personal owner', { type: 'personal' }],
  ['an array', [binding]],
  ['a slug organization id', { ...binding, organizationId: 'team-a' }],
  ['a missing project id', { ...binding, projectId: undefined }],
  ['a missing instance id', { ...binding, instanceId: undefined }],
  ['a missing generation', { ...binding, bindingGeneration: undefined }],
  ['a negative generation', { ...binding, bindingGeneration: -1 }],
  ['a fractional generation', { ...binding, bindingGeneration: 1.5 }],
  ['a string generation', { ...binding, bindingGeneration: '1' }],
])('classifies %s as malformed, never Personal', (_label, owner) => {
  expect(classifyPersistedWorkspaceOwner(owner)).toEqual({
    kind: 'malformed',
  });
});

it('normalizes only UUIDs', () => {
  expect(normalizeUuid(` ${ORG}\n`)).toBe(ORG.toLowerCase());
  for (const value of ['team-a', '', 42, null, `${ORG}0`])
    expect(normalizeUuid(value)).toBeNull();
});
