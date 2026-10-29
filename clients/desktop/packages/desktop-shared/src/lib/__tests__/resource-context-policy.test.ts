import type { ResourceOwner } from '@canopy/protocol/resource-owner';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  decideResourceContext,
  validateDependencyGraph,
  type InstallReceipt,
  type ResourceDependency,
} from '../resource-context-policy';

const personal: WorkspaceContext = { kind: 'personal' };
const orgA: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
const orgB: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};
const user: ResourceOwner = { type: 'user', id: 'user', name: null };
const organization: ResourceOwner = {
  type: 'organization',
  id: orgA.organizationId,
  name: null,
};
const team: ResourceOwner = {
  type: 'team',
  id: 'team',
  name: null,
  organization: { id: orgA.organizationId, name: null },
};
const receipt: InstallReceipt = {
  family: 'skills',
  remoteId: 'remote',
  shareScope: 'organization',
  ownerContext: orgA,
  hash: 'hash',
  authorizedAt: '2026-09-23T00:00:00.000Z',
};

describe('portable resource matrix', (): void => {
  const rows = [
    { name: 'bundled', owner: { type: 'system' }, allowed: [true, true, true] },
    {
      name: 'personal local',
      owner: { shareScope: 'private' },
      allowed: [true, true, true],
    },
    { name: 'USER private', owner: user, allowed: [true, true, true] },
    { name: 'team', owner: team, allowed: [false, true, false] },
    {
      name: 'organization',
      owner: organization,
      allowed: [false, true, false],
    },
    {
      name: 'managed install',
      owner: user,
      provenance: receipt,
      allowed: [false, true, false],
    },
    { name: 'unknown', owner: {}, allowed: [false, false, false] },
  ];
  for (const row of rows) {
    [personal, orgA, orgB].forEach((context, index): void => {
      it(`${row.name} in ${JSON.stringify(context)}`, (): void => {
        expect(
          decideResourceContext({
            resource: row,
            invocation: { mode: 'foreground', context },
          }),
        ).toEqual(
          row.allowed[index]
            ? { allow: true }
            : {
                allow: false,
                reason:
                  row.name === 'unknown'
                    ? 'unknown-provenance'
                    : 'context-mismatch',
              },
        );
      });
    });
  }
  it('keeps legacy capability compatibility explicit', (): void => {
    expect(
      decideResourceContext(
        {
          resource: { owner: {} },
          invocation: { mode: 'foreground', context: personal },
        },
        { strict: false },
      ),
    ).toEqual({ allow: true });
  });
  it('rejects a foreign target even for portable resources', (): void => {
    expect(
      decideResourceContext({
        resource: { owner: user },
        invocation: { mode: 'foreground', context: orgA },
        target: { workspaceOwner: orgB },
      }),
    ).toEqual({ allow: false, reason: 'unsupported-target' });
  });
  it('allows a Personal target linked to the invoking organization', (): void => {
    expect(
      decideResourceContext({
        resource: { owner: user },
        invocation: { mode: 'foreground', context: orgA },
        target: {
          workspaceOwner: personal,
          linkedOrganizationIds: [orgA.organizationId],
        },
      }),
    ).toEqual({ allow: true });
  });
  it('does not extend a Personal target link to another organization', (): void => {
    expect(
      decideResourceContext({
        resource: { owner: user },
        invocation: { mode: 'foreground', context: orgB },
        target: {
          workspaceOwner: personal,
          linkedOrganizationIds: [orgA.organizationId],
        },
      }),
    ).toEqual({ allow: false, reason: 'unsupported-target' });
  });
  it('keeps Personal targets strict without an explicit linked audience', (): void => {
    expect(
      decideResourceContext({
        resource: { owner: user },
        invocation: { mode: 'foreground', context: orgA },
        target: { workspaceOwner: personal },
      }),
    ).toEqual({ allow: false, reason: 'unsupported-target' });
  });
  it('applies owner and provenance checks before a linked target audience', (): void => {
    const target = {
      workspaceOwner: personal,
      linkedOrganizationIds: [orgA.organizationId],
    };
    expect(
      decideResourceContext({
        resource: { owner: organization },
        invocation: { mode: 'foreground', context: orgB },
        target,
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
    expect(
      decideResourceContext({
        resource: { owner: user, provenance: receipt },
        invocation: { mode: 'foreground', context: orgB },
        target,
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
  });
  it('does not let a private receipt erase the wire owner', (): void => {
    expect(
      decideResourceContext({
        resource: {
          owner: organization,
          provenance: {
            ...receipt,
            shareScope: 'private',
            ownerContext: personal,
          },
        },
        invocation: { mode: 'foreground', context: personal },
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
  });
});

describe('dependency audience table', (): void => {
  const owners: ResourceOwner[] = [
    user,
    { ...user, id: 'other-user' },
    { type: 'system' },
    team,
    { ...team, id: 'other-team' },
    organization,
    { ...organization, id: orgB.organizationId },
  ];
  const rows = [
    { parent: user, allowed: [true, false, true, false, false, false, false] },
    { parent: team, allowed: [false, false, false, true, false, true, false] },
    {
      parent: organization,
      allowed: [false, false, false, false, false, true, false],
    },
  ];
  for (const row of rows) {
    owners.forEach((owner, index): void => {
      it(`${row.parent.type} -> ${owner.type} ${index}`, (): void => {
        expect(
          validateDependencyGraph(row.parent, [{ owner, available: true }]),
        ).toEqual(
          row.allowed[index]
            ? { allow: true }
            : { allow: false, reason: 'missing-dependency' },
        );
      });
    });
  }
  it.each([null, {}, { type: 'team' }])(
    'rejects unknown dependency %j',
    (owner): void => {
      expect(
        validateDependencyGraph(user, [{ owner, available: true }]),
      ).toEqual({ allow: false, reason: 'missing-dependency' });
    },
  );
  it('rejects revoked and nested missing dependencies', (): void => {
    expect(
      validateDependencyGraph(user, [{ owner: user, available: false }]),
    ).toEqual({ allow: false, reason: 'missing-dependency' });
    expect(
      validateDependencyGraph(team, [
        {
          owner: organization,
          available: true,
          dependencies: [{ owner: team, available: true }],
        },
      ]),
    ).toEqual({ allow: false, reason: 'missing-dependency' });
  });
});

it('rejects a cyclic dependency graph', (): void => {
  const dependencies: ResourceDependency[] = [];
  const node = {
    owner: organization,
    available: true,
    dependencies,
  };
  node.dependencies.push(node);
  expect(validateDependencyGraph(organization, [node])).toEqual({
    allow: false,
    reason: 'missing-dependency',
  });
});
it('rejects malformed install provenance', (): void => {
  expect(
    decideResourceContext({
      resource: {
        owner: user,
        provenance: { ...receipt, authorizedAt: 'invalid' },
      },
      invocation: { mode: 'foreground', context: orgA },
    }),
  ).toEqual({ allow: false, reason: 'unknown-provenance' });
});
it('allows matching targets and empty complete dependency graphs', (): void => {
  expect(
    decideResourceContext({
      resource: { owner: team },
      invocation: { mode: 'foreground', context: orgA },
      target: { workspaceOwner: orgA },
    }),
  ).toEqual({ allow: true });
  expect(validateDependencyGraph(organization, [])).toEqual({ allow: true });
});

it('does not confuse active-context authorization with a Personal parent dependency grant', (): void => {
  expect(
    decideResourceContext({
      resource: { owner: organization },
      invocation: { mode: 'foreground', context: orgA },
    }),
  ).toEqual({ allow: true });
  expect(
    validateDependencyGraph(user, [{ owner: organization, available: true }]),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
  expect(
    validateDependencyGraph(organization, [
      { owner: organization, available: true },
    ]),
  ).toEqual({ allow: true });
});

it('maps owner and persisted install provenance to Personal without changing ownership', () => {
  const owner = { type: 'organization', id: orgA.organizationId, name: null };
  const resource = { owner, provenance: receipt };
  expect(
    decideResourceContext(
      { resource, invocation: { mode: 'foreground', context: personal } },
      { strict: true, personalOrganizationId: orgA.organizationId },
    ),
  ).toEqual({ allow: true });
  expect(
    decideResourceContext(
      { resource, invocation: { mode: 'foreground', context: orgA } },
      { strict: true, personalOrganizationId: orgA.organizationId },
    ),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(
    decideResourceContext(
      { resource, invocation: { mode: 'foreground', context: personal } },
      { strict: true, personalOrganizationId: null },
    ),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(
    decideResourceContext(
      { resource, invocation: { mode: 'foreground', context: orgA } },
      { strict: true, personalOrganizationId: null },
    ),
  ).toEqual({ allow: true });
});

it('allows a Personal organization share destination without relaxing unrelated workspace targets', () => {
  const input = {
    resource: {
      owner: { type: 'organization', id: orgA.organizationId, name: null },
    },
    invocation: { mode: 'foreground' as const, context: personal },
    target: { workspaceOwner: orgA },
  };
  expect(
    decideResourceContext(input, {
      personalOrganizationId: orgA.organizationId,
    }),
  ).toEqual({ allow: true });
  expect(
    decideResourceContext(
      { ...input, target: { workspaceOwner: orgB } },
      { personalOrganizationId: orgA.organizationId },
    ),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});
