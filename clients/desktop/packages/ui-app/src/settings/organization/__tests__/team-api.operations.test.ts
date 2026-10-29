/**
 * `team-api` helpers run fixed settings operations with the inputs the old
 * fetch helpers sent, and keep the `TeamApiError` contract callers branch on:
 * a route failure carries its status and code, with the route's text only as
 * the log-only `serverDetail` (the message is generic copy); a malformed body
 * logs `Invalid server response`; a request that never reached the server is not
 * a `TeamApiError`, so callers keep their generic copy.
 */
import {
  SettingsOperationError,
  validateSettingsOperationInput,
} from '@canopy/protocol/settings';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  clearOrgLogo,
  getCreditsBalance,
  getCreditsLedger,
  getOrgChargeHistory,
  getTeamFeed,
  getWorktreeSummaryHistory,
  fetchTeamUsage,
  listOrganizations,
  renameOrganization,
  TEAM_API_ERROR_COPY,
  TeamApiError,
  toTeamApiError,
  updateDailyDrip,
  updateEnforcedSync,
  updateModelGatewayConfig,
  uploadOrgLogo,
} from '../team-api';
import {
  failOffline,
  failWith,
  respondWith,
} from './helpers/settings-responses';

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

function detail(): Record<string, unknown> {
  return {
    id: ORG_ID,
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    logoUrl: null,
  };
}

function config(): Record<string, unknown> {
  return {
    usageStatsMinRole: 'ADMIN',
    allowExternalContainerSharing: false,
    enforceMemberDataSharing: true,
    enforceMemberModelPolicy: false,
    blockedModelIds: [],
    reviewedModelIds: [],
    enforceMemberModelGateway: false,
    modelGatewayBaseUrl: null,
    modelGatewayModels: [],
    modelGatewayEnforced: false,
    modelGatewayPromptCachePassthrough: true,
    enforcedSync: {
      transcripts: null,
      plans: true,
      metadata: false,
      summaries: null,
    },
  };
}

describe('toTeamApiError', (): void => {
  it('keeps the status and code, and the route message only as the log detail', (): void => {
    const error = toTeamApiError(
      new SettingsOperationError({
        code: 'failed',
        status: 409,
        message: 'An organization must always have at least one owner',
        serverCode: 'last_owner',
      }),
    );
    expect(error).toBeInstanceOf(TeamApiError);
    expect(error).toMatchObject({
      status: 409,
      message: TEAM_API_ERROR_COPY,
      serverDetail: 'An organization must always have at least one owner',
      code: 'last_owner',
    });
    expect(String(error)).not.toContain('at least one owner');
  });

  it('carries no detail when the route sent no message', (): void => {
    const error = toTeamApiError(
      new SettingsOperationError({ code: 'forbidden', status: 403 }),
    );
    expect(error).toMatchObject({
      status: 403,
      message: TEAM_API_ERROR_COPY,
      serverDetail: undefined,
    });
  });

  it('reports a malformed body as Invalid server response', (): void => {
    const error = toTeamApiError(
      new SettingsOperationError({ code: 'invalid_response' }),
    );
    expect(error).toBeInstanceOf(TeamApiError);
    expect(error).toMatchObject({
      status: 200,
      serverDetail: 'Invalid server response',
    });
  });

  it.each(['offline', 'uncertain'] as const)(
    'leaves a %s failure without a response as it is',
    (code): void => {
      const original = new SettingsOperationError({ code });
      expect(toTeamApiError(original)).toBe(original);
    },
  );

  it('leaves other errors untouched', (): void => {
    const original = new TypeError('Failed to fetch');
    expect(toTeamApiError(original)).toBe(original);
  });
});

describe('organization helpers', (): void => {
  it('lists organizations through organization.list', async (): Promise<void> => {
    const summary = {
      id: ORG_ID,
      name: 'Acme',
      role: 'OWNER',
      memberCount: 1,
      subTeamCount: 0,
      logoUrl: null,
    };
    const client = createFakeSettingsClient({
      'organization.list': respondWith('organization.list', {
        organizations: [summary],
      }),
    });
    await expect(listOrganizations(client)).resolves.toEqual([summary]);
    expect(client.calls).toEqual([
      { operation: 'organization.list', input: {} },
    ]);
  });

  it('renames through organization.rename and maps a refusal', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.rename': respondWith('organization.rename', detail()),
    });
    await expect(
      renameOrganization(client, ORG_ID, 'Acme Labs'),
    ).resolves.toMatchObject({ id: ORG_ID });
    expect(client.calls).toEqual([
      {
        operation: 'organization.rename',
        input: { organizationId: ORG_ID, name: 'Acme Labs' },
      },
    ]);

    const refusing = createFakeSettingsClient({
      'organization.rename': failWith(
        403,
        { error: 'Only admins can rename.' },
        { write: true },
      ),
    });
    await expect(
      renameOrganization(refusing, ORG_ID, 'Acme Labs'),
    ).rejects.toMatchObject({
      status: 403,
      serverDetail: 'Only admins can rename.',
    });
  });

  it('rethrows an offline failure as a non-TeamApiError', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.logo.clear': failOffline(true),
    });
    const failure: unknown = await clearOrgLogo(client, ORG_ID).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SettingsOperationError);
    expect(failure).not.toBeInstanceOf(TeamApiError);
  });
});

describe('uploadOrgLogo', (): void => {
  const file = new Blob(['png-bytes'], { type: 'image/png' });

  it('runs the upload operation with the file and its declared type', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.logo.upload': respondWith(
        'organization.logo.upload',
        detail(),
      ),
    });
    await expect(
      uploadOrgLogo(client, ORG_ID, file, 'image/png'),
    ).resolves.toMatchObject({ id: ORG_ID });
    expect(client.calls).toEqual([
      {
        operation: 'organization.logo.upload',
        input: {
          organizationId: ORG_ID,
          mimeType: 'image/png',
          size: file.size,
          file,
        },
      },
    ]);
  });

  it('passes the table input check a real host applies', (): void => {
    // The web client validates the whole input, `file` included, against the
    // entry before signing; an entry without `file` refused every upload.
    expect(
      validateSettingsOperationInput('organization.logo.upload', {
        organizationId: ORG_ID,
        mimeType: 'image/png',
        size: file.size,
        file,
      }).ok,
    ).toBe(true);
  });

  it('surfaces a moderation refusal as a 422 TeamApiError', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.logo.upload': failWith(
        422,
        { error: 'This image did not pass moderation.' },
        { write: true },
      ),
    });
    await expect(
      uploadOrgLogo(client, ORG_ID, file, 'image/png'),
    ).rejects.toMatchObject({
      status: 422,
      serverDetail: 'This image did not pass moderation.',
    });
  });

  it('keeps a failed storage PUT out of TeamApiError', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.logo.upload': (): never => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 403,
          serverCode: 'upload_failed',
        });
      },
    });
    const failure: unknown = await uploadOrgLogo(
      client,
      ORG_ID,
      file,
      'image/png',
    ).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(TeamApiError);
  });
});

describe('settings policy writes', (): void => {
  function policiesClient(): ReturnType<typeof createFakeSettingsClient> {
    return createFakeSettingsClient({
      'organization.settings.policies.update': respondWith(
        'organization.settings.policies.update',
        config(),
      ),
    });
  }

  it('re-asserts the master switch with the enforced scopes', async (): Promise<void> => {
    const client = policiesClient();
    await updateEnforcedSync(
      client,
      ORG_ID,
      { transcripts: false, plans: true, metadata: null, summaries: null },
      true,
    );
    expect(client.calls[0]).toEqual({
      operation: 'organization.settings.policies.update',
      input: {
        organizationId: ORG_ID,
        enforceMemberDataSharing: true,
        enforcedSync: {
          transcripts: false,
          plans: true,
          metadata: null,
          summaries: null,
        },
      },
    });
  });

  it('sends the whole gateway state with only the contract model fields', async (): Promise<void> => {
    const client = policiesClient();
    const model = {
      id: 'opus',
      gatewayId: 'anthropic/claude-opus-5',
      label: 'Opus',
      harness: 'claude' as const,
      contextWindow: 200_000,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard' as const,
      addedLater: true,
    };
    await updateModelGatewayConfig(client, ORG_ID, {
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gateway.example.com',
      modelGatewayModels: [model],
      modelGatewayEnforced: true,
      modelGatewayPromptCachePassthrough: false,
    });
    expect(client.calls[0]?.input).toEqual({
      organizationId: ORG_ID,
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gateway.example.com',
      modelGatewayModels: [
        {
          id: 'opus',
          gatewayId: 'anthropic/claude-opus-5',
          label: 'Opus',
          harness: 'claude',
          contextWindow: 200_000,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      modelGatewayEnforced: true,
      modelGatewayPromptCachePassthrough: false,
    });
  });
});

describe('feed and usage reads', (): void => {
  it('sends only the non-empty feed filters', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.feed.page': respondWith('organization.feed.page', {
        items: [],
        nextCursor: null,
      }),
    });
    await getTeamFeed(client, ORG_ID, 'c1', {
      q: 'deploy',
      types: ['pr_opened'],
      actorId: 'user-1',
    });
    await getTeamFeed(client, ORG_ID, '', { q: '', types: [] });
    expect(client.calls.map((call) => call.input)).toEqual([
      {
        organizationId: ORG_ID,
        cursor: 'c1',
        q: 'deploy',
        types: ['pr_opened'],
        actorId: 'user-1',
      },
      { organizationId: ORG_ID },
    ]);
  });

  it('pages summary history with the cursor and limit', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.feed.summaryHistory': respondWith(
        'organization.feed.summaryHistory',
        { entries: [], nextCursor: null },
      ),
    });
    await getWorktreeSummaryHistory(client, ORG_ID, 'item-1', {
      cursor: 'c2',
      limit: 10,
    });
    expect(client.calls[0]).toEqual({
      operation: 'organization.feed.summaryHistory',
      input: {
        organizationId: ORG_ID,
        itemId: 'item-1',
        cursor: 'c2',
        limit: 10,
      },
    });
  });

  it('omits an empty team and user filter from the usage read', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.statistics.usage': (): never => {
        throw new SettingsOperationError({ code: 'offline' });
      },
    });
    await fetchTeamUsage(client, ORG_ID, {
      scope: 'organization',
      granularity: 'day',
      startIso: '2026-10-01T00:00:00.000Z',
      endIso: '2026-10-16T00:00:00.000Z',
      teamId: '',
      userId: 'user-1',
    }).catch(() => undefined);
    expect(client.calls[0]?.input).toEqual({
      organizationId: ORG_ID,
      scope: 'organization',
      granularity: 'day',
      startIso: '2026-10-01T00:00:00.000Z',
      endIso: '2026-10-16T00:00:00.000Z',
      userId: 'user-1',
    });
  });
});

describe('billing reads and daily free credits', (): void => {
  it('reads the personal wallet or the organization pool', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'account.billing.credits': () => ({ balanceCredits: 1 }),
      'organization.billing.credits': () => ({ balanceCredits: 2 }),
      'account.billing.creditsLedger': () => ({ entries: [] }),
      'organization.billing.credits.ledger': () => ({ entries: [] }),
    });
    await getCreditsBalance(client);
    await getCreditsBalance(client, ORG_ID);
    await getCreditsLedger(client, undefined, { cursor: null });
    await getCreditsLedger(client, ORG_ID, { limit: 20, cursor: 'c3' });
    expect(client.calls).toEqual([
      { operation: 'account.billing.credits', input: {} },
      {
        operation: 'organization.billing.credits',
        input: { organizationId: ORG_ID },
      },
      { operation: 'account.billing.creditsLedger', input: {} },
      {
        operation: 'organization.billing.credits.ledger',
        input: { organizationId: ORG_ID, limit: 20, cursor: 'c3' },
      },
    ]);
  });

  it('pages charge history without an empty cursor', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'organization.billing.history': () => ({ charges: [], nextCursor: null }),
    });
    await getOrgChargeHistory(client, ORG_ID, { limit: 5, cursor: null });
    expect(client.calls[0]?.input).toEqual({
      organizationId: ORG_ID,
      limit: 5,
    });
  });

  it('saves the daily free credits choice through the account operation', async (): Promise<void> => {
    const saved = {
      enabled: true,
      decidedAt: '2026-10-16T00:00:00.000Z',
      capCredits: 50,
      balanceCredits: 50,
      granted: 50,
    };
    const client = createFakeSettingsClient({
      'account.billing.dailyFreeCredits.update': respondWith(
        'account.billing.dailyFreeCredits.update',
        saved,
      ),
    });
    await expect(updateDailyDrip(client, { enabled: true })).resolves.toEqual(
      saved,
    );
    expect(client.calls).toEqual([
      {
        operation: 'account.billing.dailyFreeCredits.update',
        input: { enabled: true },
      },
    ]);
  });

  it('rejects a daily free credits result the strict parser refuses', async (): Promise<void> => {
    const client = createFakeSettingsClient({
      'account.billing.dailyFreeCredits.update': respondWith(
        'account.billing.dailyFreeCredits.update',
        {
          enabled: true,
          decidedAt: null,
          capCredits: 50,
          balanceCredits: null,
          granted: -1,
        },
      ),
    });
    await expect(
      updateDailyDrip(client, { enabled: true }),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });
});
