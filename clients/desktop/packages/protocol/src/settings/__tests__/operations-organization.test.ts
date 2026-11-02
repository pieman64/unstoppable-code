import {
  ORGANIZATION_SETTINGS_OPERATIONS,
  type OrganizationSettingsOperationName,
} from '../operations-organization';
import type {
  AnySettingsOperation,
  SettingsOperationRequest,
} from '../operation-definition';

const ORG = '7b0c1f0e-4c1a-4d55-9b52-1d3c5e9f0a11';
const USER = '2d6f8a90-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OPERATION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

/** One valid input per entry; `satisfies` keeps it exhaustive. */
const VALID_INPUTS = {
  'organization.list': {},
  'organization.create': { name: 'Acme' },
  'organization.detail': { organizationId: ORG },
  'organization.rename': { organizationId: ORG, name: 'Acme Labs' },
  'organization.delete': { organizationId: ORG },
  'organization.leave': { organizationId: ORG },
  'organization.logo.upload': {
    organizationId: ORG,
    mimeType: 'image/png',
    size: 1024,
  },
  'organization.logo.clear': { organizationId: ORG },
  'organization.promote': {
    organizationId: ORG,
    name: 'Acme',
    operationId: OPERATION_ID,
  },
  'organization.members.invite': {
    organizationId: ORG,
    email: 'teammate@example.com',
    role: 'ADMIN',
  },
  'organization.invitations.status': {
    organizationId: ORG,
    email: 'teammate@example.com',
  },
  'organization.invitations.list': { organizationId: ORG },
  'organization.invitations.revoke': { organizationId: ORG, inviteId: OTHER },
  'organization.invitations.incoming': {},
  'organization.invitations.respond': { inviteId: OTHER, action: 'accept' },
  'organization.members.updateRole': {
    organizationId: ORG,
    userId: USER,
    role: 'ADMIN',
  },
  'organization.members.remove': { organizationId: ORG, userId: USER },
  'organization.members.memory.update': {
    organizationId: ORG,
    userId: USER,
    enabled: true,
  },
  'organization.members.profile.update': {
    organizationId: ORG,
    userId: USER,
    name: 'Sam',
  },
  'organization.members.profile.avatar.upload': {
    organizationId: ORG,
    userId: USER,
    mimeType: 'image/jpeg',
    size: 2048,
  },
  'organization.members.plans': { organizationId: ORG, userId: USER },
  'organization.members.approvedPlans': {
    organizationId: ORG,
    userId: USER,
    cursor: 'c1',
  },
  'organization.members.runs': { organizationId: ORG, userId: USER },
  'organization.members.pipelines': { organizationId: ORG, userId: USER },
  'organization.members.digests': { organizationId: ORG, userId: USER },
  'organization.teams.create': { organizationId: ORG, name: 'Platform' },
  'organization.teams.rename': {
    organizationId: ORG,
    teamId: OTHER,
    name: 'Infra',
  },
  'organization.teams.delete': { organizationId: ORG, teamId: OTHER },
  'organization.teams.setMembers': {
    organizationId: ORG,
    teamId: OTHER,
    memberUserIds: [USER],
  },
  'organization.feed.page': {
    organizationId: ORG,
    cursor: 'next',
    q: 'deploy',
    types: ['pr_opened', 'pr_merged'],
    actorId: USER,
  },
  'organization.feed.item': { organizationId: ORG, itemId: 'item-1' },
  'organization.feed.summaryHistory': {
    organizationId: ORG,
    itemId: 'item-1',
    limit: 20,
  },
  'organization.statistics.usage': {
    organizationId: ORG,
    scope: 'organization',
    granularity: 'day',
    startIso: '2026-10-01T00:00:00.000Z',
    endIso: '2026-10-16T00:00:00.000Z',
  },
  'organization.statistics.routingBacktest.lookup': {
    organizationId: ORG,
    scope: 'team',
    teamId: OTHER,
    startIso: '2026-10-01T00:00:00.000Z',
    endIso: '2026-10-16T00:00:00.000Z',
  },
  'organization.statistics.routingBacktest.create': {
    organizationId: ORG,
    scope: 'organization',
    startIso: '2026-10-01T00:00:00.000Z',
    endIso: '2026-10-16T00:00:00.000Z',
    mode: 'sample',
  },
  'organization.statistics.routingBacktest.get': {
    organizationId: ORG,
    backtestId: OTHER,
  },
  'organization.dataSharing.viewer': { organizationId: ORG },
  'organization.settings.config': { organizationId: ORG },
  'organization.settings.usage.update': {
    organizationId: ORG,
    usageStatsMinRole: 'MEMBER',
  },
  'organization.settings.policies.update': {
    organizationId: ORG,
    enforceMemberDataSharing: true,
  },
  'organization.settings.modelCatalog': {},
  'organization.settings.subscriptionPricing': { organizationId: ORG },
  'organization.settings.subscriptionPricing.update': {
    organizationId: ORG,
    planKey: 'claude-max',
    monthlyPriceUsd: 200,
  },
  'organization.settings.memoryParticipation': { organizationId: ORG },
  'organization.github.connect': { organizationId: ORG },
  'organization.github.disconnect': { organizationId: ORG },
  'organization.github.repositories': {
    organizationId: ORG,
    query: 'canopy',
  },
  'organization.repositories.list': { organizationId: ORG, fresh: true },
  'organization.repositories.refresh': { organizationId: ORG },
  'organization.repositories.setHidden': {
    organizationId: ORG,
    repositoryId: '123456',
    hidden: true,
    owner: 'acme',
    name: 'api',
  },
  'organization.projects.list': { organizationId: ORG, limit: 50 },
  'organization.projects.memberList': { organizationId: ORG },
  'organization.projects.create': {
    organizationId: ORG,
    repositories: [{ providerRepoId: '123456', owner: 'acme', name: 'api' }],
    grants: [{ principal: { type: 'organization' }, defaultListed: false }],
  },
  'organization.projects.get': { organizationId: ORG, projectId: OTHER },
  'organization.projects.update': {
    organizationId: ORG,
    projectId: OTHER,
    revision: 3,
    name: 'API',
  },
  'organization.projects.grants.replace': {
    organizationId: ORG,
    projectId: OTHER,
    authorizationVersion: 2,
    grants: [
      { principal: { type: 'user', userId: USER }, defaultListed: true },
    ],
  },
  'organization.projects.preference.set': {
    organizationId: ORG,
    projectId: OTHER,
    preference: 'ADDED',
  },
  'organization.projects.lifecycle': {
    organizationId: ORG,
    projectId: OTHER,
    revision: 3,
    action: 'archive',
  },
  'organization.memory.facts': {
    organizationId: ORG,
    evidenceType: 'OBSERVED',
    liveness: 'live',
    from: '2026-10-01',
  },
  'organization.memory.fact': { organizationId: ORG, factId: OTHER },
  'organization.memory.factsBatch': {
    organizationId: ORG,
    factIds: [OTHER, USER],
  },
  'organization.memory.factSource': {
    organizationId: ORG,
    factId: OTHER,
    sourceId: USER,
  },
  'organization.memory.graph': { organizationId: ORG, liveness: 'all' },
  'organization.memory.jobs': { organizationId: ORG, status: 'FAILED' },
  'organization.memory.searchLog': { organizationId: ORG },
  'organization.memory.config': { organizationId: ORG },
  'organization.memory.previewSearch': {
    organizationId: ORG,
    query: 'deploys',
  },
  'organization.digests.list': { organizationId: ORG },
  'organization.digests.get': { organizationId: ORG, digestId: OTHER },
  'organization.digests.request': {
    organizationId: ORG,
    startDate: '2026-10-01',
    endDate: '2026-10-07',
  },
  'organization.digests.sharing.update': {
    organizationId: ORG,
    digestId: OTHER,
    action: 'set-sharing',
    sharingEnabled: true,
  },
  'organization.digests.preferences': { organizationId: ORG },
  'organization.digests.preferences.update': {
    organizationId: ORG,
    daily: false,
    weekly: true,
    monthly: false,
    weeklyAnchorDay: 1,
  },
  'organization.billing.summary': { organizationId: ORG },
  'organization.billing.history': { organizationId: ORG, limit: 25 },
  'organization.billing.invoices': { organizationId: ORG, cursor: 'c2' },
  'organization.billing.credits': { organizationId: ORG },
  'organization.billing.credits.ledger': { organizationId: ORG },
} as const satisfies Record<OrganizationSettingsOperationName, object>;

function isOperationName(
  value: string,
): value is OrganizationSettingsOperationName {
  return Object.prototype.hasOwnProperty.call(
    ORGANIZATION_SETTINGS_OPERATIONS,
    value,
  );
}

const NAMES = Object.keys(ORGANIZATION_SETTINGS_OPERATIONS).filter(
  isOperationName,
);

function entry(name: OrganizationSettingsOperationName): AnySettingsOperation {
  return ORGANIZATION_SETTINGS_OPERATIONS[name];
}

function parseValid(name: OrganizationSettingsOperationName): unknown {
  return entry(name).input.parse(VALID_INPUTS[name]);
}

/** Every request an entry can produce for its valid input. */
function requestsFor(
  name: OrganizationSettingsOperationName,
): SettingsOperationRequest[] {
  const operation = entry(name);
  const input = parseValid(name);
  const requests = [operation.request(input)];
  if (operation.upload !== undefined) {
    requests.push(operation.upload.sign(input));
    requests.push(
      operation.upload.commit(input, {
        uploadUrl: 'https://storage.example.com/signed',
        filePath: 'quarantine/object.png',
      }),
    );
  }
  return requests;
}

/** Financial routes that must never enter the hosted settings table. */
const FINANCIAL_PATH_PATTERNS: readonly RegExp[] = [
  /\/billing\/seat-quote/,
  /\/billing\/setup-intent/,
  /\/billing\/payment-method/,
  /\/billing\/subscription\//,
  /\/billing\/credits\/top-up/,
  /\/billing\/credits\/auto-top-up/,
  /\/billing\/credits\/daily-drip/,
];

describe('ORGANIZATION_SETTINGS_OPERATIONS', () => {
  it('has a valid fixture for every entry and no fixture without an entry', () => {
    expect(Object.keys(VALID_INPUTS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(entry(name).input.safeParse(VALID_INPUTS[name]).success).toBe(
        true,
      );
    }
  });

  it('uses dotted organization names', () => {
    for (const name of NAMES) {
      expect(name).toMatch(/^organization(\.[a-z][A-Za-z]*)+$/);
    }
  });

  it('builds host-free /api/ paths for every request', () => {
    for (const name of NAMES) {
      for (const request of requestsFor(name)) {
        expect(request.path.startsWith('/api/')).toBe(true);
        expect(request.path).not.toMatch(/^[a-z]+:/i);
        expect(request.path).not.toContain('//');
        expect(request.path).not.toContain('..');
      }
    }
  });

  it('never reaches a financial route', () => {
    for (const name of NAMES) {
      for (const request of requestsFor(name)) {
        for (const pattern of FINANCIAL_PATH_PATTERNS) {
          expect(request.path).not.toMatch(pattern);
        }
      }
    }
  });

  it('only uses upload transport with an upload definition', () => {
    for (const name of NAMES) {
      const operation = entry(name);
      expect(operation.transport === 'upload').toBe(
        operation.upload !== undefined,
      );
      expect(operation.transport).not.toBe('auth');
    }
  });

  it('rejects unknown input keys on every entry', () => {
    for (const name of NAMES) {
      const result = entry(name).input.safeParse({
        ...VALID_INPUTS[name],
        url: 'https://evil.example.com',
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects malformed organization ids on every org-scoped entry', () => {
    const badIds = ['', '../escape', 'a/b', 'a b', '%2e%2e', '.hidden'];
    for (const name of NAMES) {
      const valid: object = VALID_INPUTS[name];
      if (!('organizationId' in valid)) continue;
      for (const organizationId of badIds) {
        expect(
          entry(name).input.safeParse({ ...valid, organizationId }).success,
        ).toBe(false);
      }
    }
  });

  it('encodes identifiers as single path segments', () => {
    const request = entry('organization.members.remove').request(
      entry('organization.members.remove').input.parse({
        organizationId: 'org:1.a',
        userId: 'user:2',
      }),
    );
    expect(request).toEqual({
      method: 'DELETE',
      path: '/api/account/organizations/org%3A1.a/members/user%3A2',
    });
  });

  it('mirrors the existing team-api requests', () => {
    expect(requestsFor('organization.feed.page')[0]).toEqual({
      method: 'GET',
      path: `/api/account/organizations/${ORG}/feed?cursor=next&q=deploy&types=pr_opened%2Cpr_merged&actorId=${USER}`,
    });
    expect(requestsFor('organization.statistics.usage')[0]).toEqual({
      method: 'GET',
      path: `/api/account/organizations/${ORG}/usage?scope=organization&granularity=day&start=2026-10-01T00%3A00%3A00.000Z&end=2026-10-16T00%3A00%3A00.000Z`,
    });
    expect(requestsFor('organization.members.invite')[0]).toEqual({
      method: 'POST',
      path: '/api/account/invites',
      body: {
        organizationId: ORG,
        email: 'teammate@example.com',
        role: 'ADMIN',
      },
    });
    expect(requestsFor('organization.promote')[0]).toEqual({
      method: 'POST',
      path: `/api/account/organizations/${ORG}/upgrade`,
      body: { organizationId: ORG, name: 'Acme', operationId: OPERATION_ID },
    });
    expect(requestsFor('organization.github.connect')[0]).toEqual({
      method: 'POST',
      path: `/api/account/teams/${ORG}/github/connect`,
    });
    expect(requestsFor('organization.repositories.list')[0]).toEqual({
      method: 'GET',
      path: `/api/account/organizations/${ORG}/projects/repositories?fresh=1`,
    });
    expect(requestsFor('organization.projects.list')[0]).toEqual({
      method: 'GET',
      path: `/api/account/organizations/${ORG}/projects?view=management&limit=50`,
    });
    expect(requestsFor('organization.memory.factsBatch')[0]?.path).toBe(
      `/api/account/organizations/${ORG}/memory-explorer/facts/batch?ids=${OTHER}%2C${USER}`,
    );
    expect(requestsFor('organization.logo.clear')[0]).toEqual({
      method: 'PATCH',
      path: `/api/account/organizations/${ORG}`,
      body: { logoUrl: null },
    });
  });

  it('defaults an invite role to MEMBER and omits an absent sub-team', () => {
    const operation = entry('organization.members.invite');
    expect(
      operation.request(
        operation.input.parse({ organizationId: ORG, email: 'a@example.com' }),
      ).body,
    ).toEqual({ organizationId: ORG, email: 'a@example.com', role: 'MEMBER' });
    expect(
      operation.input.safeParse({
        organizationId: ORG,
        email: 'a@example.com',
        role: 'OWNER',
      }).success,
    ).toBe(false);
  });

  it('sends only the policy fields a caller changes', () => {
    const operation = entry('organization.settings.policies.update');
    expect(
      operation.request(
        operation.input.parse({
          organizationId: ORG,
          blockedModelIds: ['anthropic/claude-opus-5'],
          reviewedModelIds: ['anthropic/claude-opus-5', 'gpt-5.3-codex-spark'],
        }),
      ),
    ).toEqual({
      method: 'PATCH',
      path: `/api/account/organizations/${ORG}/config`,
      body: {
        blockedModelIds: ['anthropic/claude-opus-5'],
        reviewedModelIds: ['anthropic/claude-opus-5', 'gpt-5.3-codex-spark'],
      },
    });
    expect(operation.input.safeParse({ organizationId: ORG }).success).toBe(
      false,
    );
    expect(
      operation.input.safeParse({
        organizationId: ORG,
        enforcedSync: {
          transcripts: null,
          plans: true,
          metadata: false,
          summaries: null,
        },
        enforceMemberDataSharing: true,
      }).success,
    ).toBe(true);
  });

  it('requires a team id for a team-scoped usage read', () => {
    expect(
      entry('organization.statistics.usage').input.safeParse({
        ...VALID_INPUTS['organization.statistics.usage'],
        scope: 'team',
      }).success,
    ).toBe(false);
  });

  it('describes the logo and member avatar signed uploads', () => {
    for (const name of [
      'organization.logo.upload',
      'organization.members.profile.avatar.upload',
    ] as const) {
      const operation = entry(name);
      expect(operation.upload?.maxBytes).toBe(5 * 1024 * 1024);
      expect(operation.upload?.contentTypes).toEqual([
        'image/png',
        'image/jpeg',
        'image/gif',
      ]);
      expect(
        operation.input.safeParse({
          ...VALID_INPUTS[name],
          size: 5 * 1024 * 1024 + 1,
        }).success,
      ).toBe(false);
      expect(
        operation.input.safeParse({
          ...VALID_INPUTS[name],
          mimeType: 'image/svg+xml',
        }).success,
      ).toBe(false);
    }
    const [, sign, commit] = requestsFor('organization.logo.upload');
    expect(sign).toEqual({
      method: 'POST',
      path: `/api/account/organizations/${ORG}/logo/upload-url`,
      body: { mimeType: 'image/png', size: 1024 },
    });
    expect(commit).toEqual({
      method: 'POST',
      path: `/api/account/organizations/${ORG}/logo/commit`,
      body: { filePath: 'quarantine/object.png' },
    });
    const logo = entry('organization.logo.upload');
    expect(() =>
      logo.upload?.commit(parseValid('organization.logo.upload'), {
        uploadUrl: 'https://storage.example.com/signed',
      }),
    ).toThrow('no object path');
  });

  describe('result schemas', () => {
    const detail = {
      id: ORG,
      name: 'Acme',
      viewerRole: 'OWNER',
      members: [
        {
          id: USER,
          name: 'Sam',
          email: 'sam@example.com',
          image: null,
          role: 'OWNER',
          subTeamIds: [],
        },
      ],
      subTeams: [{ id: OTHER, name: 'Platform', memberCount: 1 }],
      usageStatsMinRole: 'ADMIN',
      canViewUsageStats: true,
      logoUrl: null,
      githubConnection: { connected: false, accountLogin: null },
      futureField: 'tolerated',
    };

    function accepts(
      name: OrganizationSettingsOperationName,
      value: unknown,
    ): boolean {
      return entry(name).result.safeParse(value).success;
    }

    const incomingInvitation = {
      id: OTHER,
      organizationName: 'Acme',
      organizationTeamName: null,
      role: 'MEMBER',
      invitedByName: 'Sam',
      createdAt: '2026-10-16T00:00:00.000Z',
      expiresAt: '2026-11-16T00:00:00.000Z',
    };

    it('accepts legacy incoming invitations and preserves external organization ids', () => {
      const schema = entry('organization.invitations.incoming').result;
      const legacy = { invitations: [incomingInvitation] };
      const identified = {
        invitations: [{ ...incomingInvitation, organizationId: ORG }],
      };
      expect(schema.parse(legacy)).toEqual(legacy);
      expect(schema.parse(identified)).toEqual(identified);
    });

    it.each([42, null, {}, []])(
      'rejects an invalid incoming invitation organization id: %p',
      (organizationId) => {
        expect(
          accepts('organization.invitations.incoming', {
            invitations: [{ ...incomingInvitation, organizationId }],
          }),
        ).toBe(false);
      },
    );

    it('validates organization detail and lists', () => {
      expect(accepts('organization.detail', detail)).toBe(true);
      expect(
        accepts('organization.detail', { ...detail, viewerRole: 'GOD' }),
      ).toBe(false);
      expect(accepts('organization.detail', { ...detail, members: null })).toBe(
        false,
      );
      expect(
        accepts('organization.list', {
          organizations: [
            {
              id: ORG,
              name: 'Acme',
              role: 'MEMBER',
              memberCount: 3,
              subTeamCount: 0,
            },
          ],
        }),
      ).toBe(true);
      expect(
        accepts('organization.list', { organizations: [{ id: ORG }] }),
      ).toBe(false);
    });

    it('validates the organization config', () => {
      const config = {
        usageStatsMinRole: 'ADMIN',
        allowExternalContainerSharing: false,
        enforceMemberModelPolicy: false,
        blockedModelIds: [],
        reviewedModelIds: [],
        enforceMemberModelGateway: false,
        modelGatewayBaseUrl: null,
        modelGatewayModels: [],
        modelGatewayEnforced: false,
        modelGatewayPromptCachePassthrough: true,
        enforceMemberDataSharing: true,
        enforcedSync: {
          transcripts: null,
          plans: true,
          metadata: false,
          summaries: null,
        },
      };
      expect(accepts('organization.settings.config', config)).toBe(true);
      expect(
        accepts('organization.settings.config', {
          ...config,
          enforcedSync: { transcripts: null, plans: true, metadata: false },
        }),
      ).toBe(false);
    });

    it('validates feed pages leniently by frame', () => {
      const item = {
        id: 'item-1',
        type: 'pr_opened',
        occurredAt: '2026-10-16T00:00:00.000Z',
        actor: { userId: USER, displayName: null },
        worktreeId: null,
        pr: { number: 1 },
      };
      expect(
        accepts('organization.feed.page', { items: [item], nextCursor: null }),
      ).toBe(true);
      expect(
        accepts('organization.feed.page', {
          items: [{ ...item, type: 'unknown_type' }],
          nextCursor: null,
        }),
      ).toBe(false);
    });

    it('validates the invite, promotion and invitation replies', () => {
      expect(
        accepts('organization.members.invite', {
          id: OTHER,
          code: 'abc',
          status: 'ACTIVE',
          organizationId: ORG,
          organizationTeamName: null,
          role: 'MEMBER',
          invitedEmail: 'teammate@example.com',
          emailQueued: true,
          emailSuppressed: false,
          emailDeferred: false,
          seatPaymentState: 'READY',
        }),
      ).toBe(true);
      expect(accepts('organization.members.invite', { id: OTHER })).toBe(false);
      expect(
        accepts('organization.promote', {
          organizationId: ORG,
          name: 'Acme',
          personalOrganizationId: OTHER,
          operationId: OPERATION_ID,
          alreadyUpgraded: false,
          warnings: [],
        }),
      ).toBe(true);
      expect(
        accepts('organization.invitations.status', { status: 'not-found' }),
      ).toBe(true);
      expect(
        accepts('organization.invitations.status', { status: 'lost' }),
      ).toBe(false);
      expect(accepts('organization.invitations.revoke', null)).toBe(true);
    });

    it('validates memory and project payloads', () => {
      const fact = {
        id: OTHER,
        factText: 'Deploys run on Fridays',
        evidenceType: 'OBSERVED',
        evidenceQuote: null,
        validAt: null,
        invalidAt: null,
        createdAt: '2026-10-16T00:00:00.000Z',
        expiredAt: null,
        invalidatedById: null,
        liveness: 'live',
        entities: [{ id: USER, canonicalName: 'deploy', entityType: 'TOOL' }],
      };
      expect(
        accepts('organization.memory.facts', {
          facts: [fact],
          nextCursor: null,
        }),
      ).toBe(true);
      expect(
        accepts('organization.memory.facts', {
          facts: [{ ...fact, liveness: 'zombie' }],
          nextCursor: null,
        }),
      ).toBe(false);
      const project = {
        id: OTHER,
        organizationId: ORG,
        name: 'API',
        description: null,
        kind: 'CODE',
        location: 'LOCAL',
        repository: null,
        state: 'DELETED',
        revision: 4,
        authorizationVersion: 1,
        defaultListed: false,
        preference: 'FOLLOW_DEFAULTS',
        listed: false,
        capabilities: { administer: true, manageCloud: false, use: true },
        instance: null,
        grants: [{ principal: { type: 'organization' }, defaultListed: false }],
        createdBy: { id: USER, name: null },
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
      };
      expect(accepts('organization.projects.lifecycle', project)).toBe(true);
      expect(
        accepts('organization.projects.lifecycle', {
          ...project,
          grants: 'none',
        }),
      ).toBe(false);
    });

    it('validates non-payment billing reads', () => {
      expect(
        accepts('organization.billing.history', {
          charges: [],
          nextCursor: null,
        }),
      ).toBe(true);
      expect(accepts('organization.billing.history', { charges: 'x' })).toBe(
        false,
      );
      expect(
        accepts('organization.billing.invoices', {
          invoices: [],
          nextCursor: null,
        }),
      ).toBe(true);
      expect(accepts('organization.billing.invoices', {})).toBe(false);
    });
  });
});
