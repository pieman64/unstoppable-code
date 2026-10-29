import {
  normalizeWorkspaceOwner,
  normalizeWorkspaceOwnershipTransfer,
  workspaceOwnerMatchesContext,
} from '../workspace-owner';

const ORG = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INSTANCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('normalizeWorkspaceOwner', () => {
  it('accepts a complete organization binding and lower-cases the ids', () => {
    expect(
      normalizeWorkspaceOwner({
        type: 'organization',
        organizationId: ORG,
        projectId: PROJECT,
        instanceId: INSTANCE,
        bindingGeneration: 2,
      }),
    ).toEqual({
      type: 'organization',
      organizationId: ORG.toLowerCase(),
      projectId: PROJECT,
      instanceId: INSTANCE,
      bindingGeneration: 2,
    });
  });

  it('reads anything malformed as Personal instead of failing the workspace', () => {
    expect(normalizeWorkspaceOwner(undefined)).toBeUndefined();
    expect(normalizeWorkspaceOwner({ type: 'personal' })).toBeUndefined();
    expect(
      normalizeWorkspaceOwner({
        type: 'organization',
        organizationId: 'not-a-uuid',
        projectId: PROJECT,
        instanceId: INSTANCE,
        bindingGeneration: 1,
      }),
    ).toBeUndefined();
    expect(
      normalizeWorkspaceOwner({
        type: 'organization',
        organizationId: ORG,
        projectId: PROJECT,
        instanceId: INSTANCE,
        bindingGeneration: -1,
      }),
    ).toBeUndefined();
  });
});

describe('workspaceOwnerMatchesContext', () => {
  const owner = {
    type: 'organization' as const,
    organizationId: ORG.toLowerCase(),
  };

  it('matches everything without a context', () => {
    expect(workspaceOwnerMatchesContext(undefined, undefined)).toBe(true);
    expect(workspaceOwnerMatchesContext(owner, undefined)).toBe(true);
  });

  it('matches only unowned rows in Personal and only the owner organization otherwise', () => {
    expect(workspaceOwnerMatchesContext(undefined, { kind: 'personal' })).toBe(
      true,
    );
    expect(workspaceOwnerMatchesContext(owner, { kind: 'personal' })).toBe(
      false,
    );
    expect(
      workspaceOwnerMatchesContext(owner, {
        kind: 'organization',
        organizationId: ORG.toLowerCase(),
      }),
    ).toBe(true);
    expect(
      workspaceOwnerMatchesContext(undefined, {
        kind: 'organization',
        organizationId: ORG.toLowerCase(),
      }),
    ).toBe(false);
  });
});

describe('normalizeWorkspaceOwnershipTransfer', () => {
  const record = {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId: ORG,
    projectId: PROJECT,
    convertedAt: '2026-09-27T10:00:00.000Z',
  };

  it('keeps a conversion record and its move back, lower-casing ids', () => {
    expect(normalizeWorkspaceOwnershipTransfer(record)).toEqual({
      ...record,
      organizationId: ORG.toLowerCase(),
    });
    expect(
      normalizeWorkspaceOwnershipTransfer({
        ...record,
        movedBackAt: '2026-09-27T11:00:00.000Z',
      }),
    ).toMatchObject({ movedBackAt: '2026-09-27T11:00:00.000Z' });
  });

  it('reads malformed or unknown records as absent', () => {
    for (const value of [
      undefined,
      { ...record, version: 2 },
      { ...record, previousOwner: { type: 'organization' } },
      { ...record, organizationId: 'nope' },
      { ...record, convertedAt: 'yesterday' },
      { ...record, movedBackAt: 5 },
    ])
      expect(normalizeWorkspaceOwnershipTransfer(value)).toBeUndefined();
  });
});
