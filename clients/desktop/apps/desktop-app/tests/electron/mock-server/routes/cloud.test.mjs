import { migrateExtractedLabsChoices } from '@canopy/protocol/experiments';
// In-process tests for the Canopy Cloud UI-automation mock surface.
//
// Run: node --test apps/desktop-app/tests/electron/mock-server/routes/cloud.test.mjs

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  DEFAULT_SCENARIO,
  getScenario,
  getScenarioActivity,
  recordScenarioActivity,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import { handleCloudRequest } from './cloud.mjs';

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handled = await handleCloudRequest(request, response, url);
    if (!handled) {
      response.writeHead(404).end('not handled');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('CAN-3844: automation writes retain the requested team parent from scenario membership', async () => {
  resetAll();
  const key = 'csk_can3844_team_owner';
  const organization = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Acme',
  };
  const team = {
    id: '55555555-5555-4555-8555-555555555551',
    name: 'Platform',
    organization,
  };
  registerScenario(key, {
    cloud: { organizations: [organization], teams: [team] },
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  let sharedId;
  try {
    const response = await fetch(`${base}/api/v1/canopy/automations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ shareScope: 'team', teamId: team.id }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    sharedId = result.id;
    assert.deepEqual(result.owner, {
      type: 'team',
      id: team.id,
      name: team.name,
      organization,
    });
  } finally {
    if (sharedId)
      await fetch(`${base}/api/v1/canopy/automations/${sharedId}`, {
        method: 'DELETE',
        headers,
      });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Personal upgrade project details preserve the catalog route after member creation', async () => {
  resetAll();
  const key = 'csk_can3706_member_catalog';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  registerScenario(key, { cloud: { personalOrganizationUpgrade: true } });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  try {
    const created = await fetch(`${base}/api/v1/projects/member`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        organizationId,
        kind: 'CODE',
        name: 'Selected project',
        repository: null,
        creationKey: 'catalog-visible',
      }),
    });
    assert.equal(created.status, 200);
    const project = await created.json();
    const catalog = await fetch(
      `${base}/api/v1/projects/catalog?context=org:${organizationId}`,
      { headers },
    );
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json()).data, [project]);
    const detail = await fetch(
      `${base}/api/v1/projects/${project.id}/share-with-organization`,
      {
        headers,
      },
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), project);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    resetAll();
  }
});

test('member creation replays a stable creation key and refuses a changed payload', async () => {
  resetAll();
  const key = 'csk_can3706_creation_replay';
  registerScenario(key, { cloud: { personalOrganizationUpgrade: true } });
  const { server, base } = await startServer();
  const request = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    kind: 'CODE',
    name: 'Personal project',
    repository: null,
    creationKey: 'stable-personal-upgrade',
  };
  const create = (body) =>
    fetch(`${base}/api/v1/projects/member`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    const first = await (await create(request)).json();
    const replay = await (await create(request)).json();
    assert.equal(replay.id, first.id);
    assert.equal(getScenarioActivity(key).orgMemberProjectCreate, 1);
    assert.equal((await create({ ...request, name: 'Changed' })).status, 409);
  } finally {
    server.close();
    resetAll();
  }
});

test('member creation recovers after committing a project and losing the response', async () => {
  resetAll();
  const key = 'csk_can3706_creation_lost';
  registerScenario(key, {
    cloud: {
      personalOrganizationUpgrade: true,
      orgMemberProjectLoseResponse: true,
    },
  });
  const { server, base } = await startServer();
  const create = () =>
    fetch(`${base}/api/v1/projects/member`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: '11111111-1111-4111-8111-111111111111',
        kind: 'CODE',
        name: 'Personal project',
        repository: null,
        creationKey: 'lost-response',
      }),
    });
  try {
    await assert.rejects(create());
    const replay = await (await create()).json();
    assert.equal(typeof replay.id, 'string');
    assert.equal(getScenarioActivity(key).orgMemberProjectCreate, 1);
    assert.equal(getScenarioActivity(key).orgMemberProjectReplay, 1);
  } finally {
    server.close();
    resetAll();
  }
});

test('Personal promotion and invitation routes keep their top-level resource namespace', async () => {
  resetAll();
  const key = 'csk_can3706_routes';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  registerScenario(key, {
    cloud: {
      personalOrganizationUpgrade: true,
      personalOrganizationId: organizationId,
      organizations: [],
    },
  });
  const { server, base } = await startServer();
  try {
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    const url = `${base}/api/v1/organizations/${organizationId}/upgrade`;
    const body = JSON.stringify({
      organizationId,
      operationId,
      name: 'Audit team',
    });
    const first = await fetch(url, { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    const promoted = await first.json();
    assert.equal(promoted.organizationId, organizationId);
    assert.notEqual(promoted.personalOrganizationId, organizationId);
    assert.equal(
      (await (await fetch(url, { method: 'POST', headers, body })).json())
        .alreadyUpgraded,
      true,
    );
    assert.equal(getScenarioActivity(key).personalOrganizationPromotion, 1);
    const inviteUrl = `${base}/api/v1/organizations/${organizationId}/invites`;
    const invitation = await fetch(inviteUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'pat@example.com' }),
    });
    assert.equal(invitation.status, 201);
    assert.equal((await invitation.json()).status, 'sent');
    assert.equal(
      (
        await (
          await fetch(`${inviteUrl}?email=pat@example.com`, { headers })
        ).json()
      ).status,
      'sent',
    );
    assert.equal(getScenarioActivity(key).organizationInvitation, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('activity-row sharing fixtures preserve real identities and are isolated by scenario', async () => {
  resetAll();
  const key = 'csk_activity_rows';
  const organization = { id: 'org-layout', name: 'Release organization' };
  registerScenario(key, {
    cloud: {
      organizations: [organization],
      activityRowShares: { skills: [], plugins: [] },
    },
  });
  registerScenario('csk_other_activity_rows', {
    cloud: { activityRowShares: { skills: [], plugins: [] } },
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  try {
    for (const kind of ['skills', 'plugins']) {
      const ref = {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'demo/market' },
        plugin_name: 'release-tools',
      };
      const result = await fetch(`${base}/api/v1/canopy/${kind}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(kind === 'skills'
            ? {
                rawSkill:
                  '---\nname: share-review\ndescription: Review the release\n---\nBody',
              }
            : { ref, name: 'Release tools' }),
          shareScope: 'organization',
          organizationId: organization.id,
        }),
      });
      assert.equal(result.status, 201);
      const created = await result.json();
      assert.equal(
        created.name,
        kind === 'skills' ? 'share-review' : 'Release tools',
      );
      assert.deepEqual(created.owner, {
        type: 'organization',
        ...organization,
      });
      if (kind === 'plugins')
        assert.equal(
          created.refKey,
          'claude_plugin:github:demo/market:release-tools',
        );
      const id = created.id ?? created.externalId;
      const detail = await fetch(`${base}/api/v1/canopy/${kind}/${id}`, {
        headers,
      });
      assert.deepEqual(await detail.json(), created);
      const published = await fetch(
        `${base}/api/v1/canopy/${kind}/${id}/public-share`,
        { method: 'POST', headers },
      );
      assert.equal(published.status, 200);
      const { publicShare } = await published.json();
      // Production links identify the resource, independently of the pin ID.
      assert.equal(publicShare.sharePath, `/share/${kind}/${id}`);
      assert.equal(
        publicShare[kind === 'skills' ? 'pinnedContentHash' : 'pinnedRefKey'],
        kind === 'skills' ? created.contentHash : created.refKey,
      );
      const refreshed = await fetch(`${base}/api/v1/canopy/${kind}/${id}`, {
        headers,
      });
      assert.deepEqual((await refreshed.json()).publicShare, publicShare);
      const other = await fetch(`${base}/api/v1/canopy/${kind}`, {
        headers: { authorization: 'Bearer csk_other_activity_rows' },
      });
      const otherList = await other.json();
      assert.deepEqual(otherList.skills ?? otherList.data, []);
    }
  } finally {
    server.close();
    resetAll();
  }
});

test('publisher catalog is anonymous and does not alias authenticated shared skills', async () => {
  const { server, base } = await startServer();
  try {
    const catalog = await fetch(`${base}/api/v1/marketplace/skills`);
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), { skills: [] });
    const sharedSkills = await fetch(`${base}/api/v1/canopy/skills`);
    assert.equal(sharedSkills.status, 401);
  } finally {
    server.close();
  }
});

test('entitlements reads honor the scenario delay and record activity', async () => {
  resetAll();
  const key = 'csk_subscription_pill_e2e';
  const delayMs = 80;
  registerScenario(key, { cloud: { entitlementsDelayMs: delayMs } });
  const { server, base } = await startServer();

  try {
    const startedAt = Date.now();
    const response = await fetch(`${base}/api/v1/entitlements`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 200);
    assert.ok(
      elapsedMs >= delayMs,
      `expected at least ${delayMs}ms of delay, observed ${elapsedMs}ms`,
    );
    assert.equal(getScenarioActivity(key).entitlementsRead, 1);
  } finally {
    server.close();
    resetAll();
  }
});

test('account reads honor the scenario delay', async () => {
  resetAll();
  const key = 'csk_account_delay_e2e';
  const delayMs = 80;
  registerScenario(key, { cloud: { accountDelayMs: delayMs } });
  const { server, base } = await startServer();

  try {
    const startedAt = Date.now();
    const response = await fetch(`${base}/api/v1/canopy/account`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 200);
    assert.ok(
      elapsedMs >= delayMs,
      `expected at least ${delayMs}ms of delay, observed ${elapsedMs}ms`,
    );
  } finally {
    server.close();
    resetAll();
  }
});

test('advertises recoverable share removal unless the scenario withholds it', async () => {
  resetAll();
  const supported = 'csk_can4052_dismissals_supported';
  const unsupported = 'csk_can4052_dismissals_unsupported';
  const capability = 'shared-container-dismissals-v1';
  registerScenario(supported, { cloud: {} });
  registerScenario(unsupported, {
    cloud: {
      withholdSharedContainerDismissalsCapability: true,
      extraCapabilities: ['extra-v1'],
    },
  });
  const { server, base } = await startServer();
  const capabilitiesOf = async (path, key) =>
    (
      await (
        await fetch(`${base}${path}`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json()
    ).capabilities;
  try {
    for (const path of [
      '/.well-known/canopy',
      '/.well-known/unstoppable-code',
    ]) {
      assert.ok((await capabilitiesOf(path, supported)).includes(capability));
      const withheld = await capabilitiesOf(path, unsupported);
      assert.ok(!withheld.includes(capability));
      // Everything else, including base sharing, is still advertised.
      assert.ok(withheld.includes('shared-containers-v1'));
    }
    const account = await capabilitiesOf('/api/v1/canopy/account', unsupported);
    assert.ok(!account.includes(capability));
    assert.ok(account.includes('shared-containers-v1'));
    assert.ok(account.includes('extra-v1'));
  } finally {
    server.close();
    resetAll();
  }
});

test('account reads can override organizations with a fresh empty list', async () => {
  resetAll();
  const key = 'csk_account_organizations_e2e';
  registerScenario(key, { cloud: { organizations: [] } });
  const { server, base } = await startServer();

  try {
    const response = await fetch(`${base}/api/v1/canopy/account`, {
      headers: { authorization: `Bearer ${key}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).organizations, []);
  } finally {
    server.close();
    resetAll();
  }
});

test('shared automation lists can come from the scenario', async () => {
  resetAll();
  const key = 'csk_shared_automations_scenario_e2e';
  const sharedAutomations = [
    { id: 'share-org', owner: { type: 'organization', id: 'org-1' } },
    { id: 'share-system', owner: { type: 'system' } },
  ];
  registerScenario(key, { cloud: { sharedAutomations } });
  const { server, base } = await startServer();

  try {
    const response = await fetch(`${base}/api/v1/canopy/automations`, {
      headers: { authorization: `Bearer ${key}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      automations: sharedAutomations,
      nextCursor: null,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('shared automation lists can be paged by the scenario', async () => {
  resetAll();
  const key = 'csk_shared_automations_paged_e2e';
  const sharedAutomations = [
    { id: 'share-1', owner: { type: 'system' } },
    { id: 'share-2', owner: { type: 'system' } },
    { id: 'share-3', owner: { type: 'system' } },
  ];
  registerScenario(key, {
    cloud: { sharedAutomations, sharedAutomationsPageSize: 2 },
  });
  const { server, base } = await startServer();

  try {
    const read = async (query) => {
      const response = await fetch(
        `${base}/api/v1/canopy/automations${query}`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await read(''), {
      automations: sharedAutomations.slice(0, 2),
      nextCursor: '2',
    });
    assert.deepEqual(await read('?cursor=2'), {
      automations: sharedAutomations.slice(2),
      nextCursor: null,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('curated automation catalog routes page and serve detail and package data', async () => {
  resetAll();
  const key = 'csk_curated_automation_routes_e2e';
  const packageDigest = `pp:v1:${'A'.repeat(43)}`;
  const entries = [0, 1].map((index) => ({
    key: `review-${index}`,
    name: `Review ${index}`,
    shortDescription: 'Review open work',
    categories: ['review'],
    actionType: 'app_advisor_prompt',
    automation: { version: 1, name: `Review ${index}` },
    packageDownload: { digest: packageDigest, manifest: { version: 1 } },
    packageBlobs: { abc: Buffer.from(`blob-${index}`).toString('base64') },
  }));
  registerScenario(key, { cloud: { curatedAutomations: entries } });
  const { server, base } = await startServer();
  const headers = { authorization: `Bearer ${key}` };

  try {
    const first = await fetch(`${base}/api/v1/curated-automations?limit=1`, {
      headers,
    });
    const firstBody = await first.json();
    assert.deepEqual(
      firstBody.data.map((entry) => entry.key),
      ['review-0'],
    );
    assert.equal(firstBody.nextCursor, '1');
    const second = await fetch(
      `${base}/api/v1/curated-automations?limit=1&cursor=${firstBody.nextCursor}`,
      { headers },
    );
    assert.deepEqual(
      (await second.json()).data.map((entry) => entry.key),
      ['review-1'],
    );
    assert.equal(
      (await fetch(`${base}/api/v1/curated-automations/review-0`, { headers }))
        .status,
      200,
    );
    const packageResponse = await fetch(
      `${base}/api/v1/curated-automations/review-0/package?expectedPackageDigest=${encodeURIComponent(packageDigest)}`,
      { headers },
    );
    assert.equal(packageResponse.status, 200);
    const blob = await fetch(
      `${base}/api/v1/curated-automations/review-0/package/blobs/abc?expectedPackageDigest=${encodeURIComponent(packageDigest)}`,
      { headers },
    );
    assert.equal(await blob.text(), 'blob-0');
  } finally {
    server.close();
    resetAll();
  }
});

test('AI Credits balance reads honor the forced failure scenario', async () => {
  resetAll();
  const key = 'csk_usage_ai_credits_tile_e2e';
  registerScenario(key, { cloud: { aiCreditsBalanceHttpStatus: 503 } });
  const { server, base } = await startServer();

  try {
    const response = await fetch(`${base}/api/v1/ai-credits/balance`, {
      headers: { authorization: `Bearer ${key}` },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Mock AI Credits balance failure (503)',
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('worker-scoped shared-container credentials receive the Business fixture', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-7';
  registerScenario(key, {});
  const { server, base } = await startServer();
  const headers = { authorization: `Bearer ${key}` };

  try {
    const account = await fetch(`${base}/api/v1/canopy/account`, { headers });
    assert.equal(account.status, 200);
    assert.equal(
      (await account.json()).organizations?.[0]?.name,
      'Shared Containers E2E',
    );

    const entitlements = await fetch(`${base}/api/v1/entitlements`, {
      headers,
    });
    assert.equal(entitlements.status, 200);
    assert.deepEqual((await entitlements.json()).plan, {
      key: 'business',
      displayName: 'Business',
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('shared-container fixture reports the external-sharing setting and opt-in team', async () => {
  resetAll();
  const offKey = 'csk_shared_containers_e2e_worker-8';
  const onKey = 'csk_shared_containers_e2e_worker-9';
  registerScenario(offKey, {});
  registerScenario(onKey, {
    sharedContainers: { allowExternalContainerSharing: true, team: true },
  });
  const { server, base } = await startServer();

  try {
    const off = await (
      await fetch(`${base}/api/v1/canopy/account`, {
        headers: { authorization: `Bearer ${offKey}` },
      })
    ).json();
    assert.equal(off.organizations?.[0]?.allowExternalContainerSharing, false);
    assert.equal(off.teams, undefined);

    const on = await (
      await fetch(`${base}/api/v1/canopy/account`, {
        headers: { authorization: `Bearer ${onKey}` },
      })
    ).json();
    assert.equal(on.organizations?.[0]?.allowExternalContainerSharing, true);
    assert.equal(on.teams?.[0]?.id, '88888888-8888-4888-8888-888888888888');
    assert.equal(
      on.teams?.[0]?.organization?.id,
      '77777777-7777-4777-8777-777777777777',
    );
  } finally {
    server.close();
    resetAll();
  }
});

test('digest preferences mirror GET and complete PATCH payloads', async () => {
  resetAll();
  const key = 'csk_digest_preferences_e2e';
  registerScenario(key, {
    cloud: {
      digestPreferences: { daily: true, weekly: false, monthly: false },
    },
  });
  const { server, base } = await startServer();

  try {
    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    };
    const loaded = await fetch(
      `${base}/api/v1/canopy/account/digest-preferences`,
      { headers },
    );
    assert.deepEqual(await loaded.json(), {
      daily: true,
      weekly: false,
      monthly: false,
      weeklyAnchorDay: 1,
      monthlyAnchorDay: 1,
    });

    const saved = await fetch(
      `${base}/api/v1/canopy/account/digest-preferences`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          daily: true,
          weekly: false,
          monthly: true,
        }),
      },
    );
    assert.deepEqual(await saved.json(), {
      daily: true,
      weekly: false,
      monthly: true,
      weeklyAnchorDay: 1,
      monthlyAnchorDay: 1,
    });
    assert.deepEqual(getScenarioActivity(key), {
      digestPreferencesRead: 1,
      digestPreferencesPatch: 1,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('notification preferences mirror GET and partial PATCH payloads', async () => {
  resetAll();
  const key = 'csk_install_update_emails_e2e';
  registerScenario(key, {
    cloud: { notificationPreferences: { installUpdateEmailsEnabled: false } },
  });
  const { server, base } = await startServer();

  try {
    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    };
    const url = `${base}/api/v1/account/notification-preferences`;
    const loaded = await fetch(url, { headers });
    assert.deepEqual(await loaded.json(), {
      pushEnabled: true,
      installUpdateEmailsEnabled: false,
    });

    const empty = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    const saved = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ installUpdateEmailsEnabled: true }),
    });
    assert.deepEqual(await saved.json(), {
      pushEnabled: true,
      installUpdateEmailsEnabled: true,
    });
    const reloaded = await fetch(url, { headers });
    assert.deepEqual(await reloaded.json(), {
      pushEnabled: true,
      installUpdateEmailsEnabled: true,
    });
    assert.deepEqual(getScenarioActivity(key), {
      notificationPreferencesRead: 2,
      notificationPreferencesPatch: 1,
    });
  } finally {
    server.close();
    resetAll();
  }
});

// Exercise the route contract directly as well as the socket-backed tests above.
test('automation public shares preserve publish and revoke state', async () => {
  const { Readable } = await import('node:stream');
  const id = 'c1f5d3a2-7b6e-4c2d-9a1b-0e8f7d6c5b4a';
  const basePath = `/api/v1/canopy/automations/${id}`;
  const automation = {
    version: 1,
    name: 'Nightly review pipeline',
    description: '',
    trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'workspace' },
      pipeline: { source: 'bundled', pipelineId: 'code-review' },
      inputKeys: [],
    },
    hasRunCondition: false,
  };
  async function request(method, pathname, body, authenticated = true) {
    const input = Readable.from(body ? [JSON.stringify(body)] : []);
    input.method = method;
    input.headers = authenticated
      ? { authorization: 'Bearer csk_automation_public_share_e2e' }
      : {};
    let status;
    let result;
    const handled = await handleCloudRequest(
      input,
      {
        writeHead(code) {
          status = code;
        },
        end(value) {
          result = value ? JSON.parse(value) : undefined;
        },
      },
      new URL(pathname, 'http://127.0.0.1'),
    );
    assert.equal(handled, true, `Missing ${method} ${pathname}`);
    return { status, body: result };
  }
  assert.equal(
    (await request('POST', `${basePath}/public-share`, undefined, false))
      .status,
    401,
  );
  const created = await request('POST', '/api/v1/canopy/automations', {
    automation,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.automation, automation);
  assert.equal(created.body.publicShare, null);
  const listed = (await request('GET', '/api/v1/canopy/automations')).body
    .automations;
  assert.equal(listed.length, 0);
  const published = await request('POST', `${basePath}/public-share`);
  assert.equal(published.status, 200);
  const publicShare = published.body.publicShare;
  const publishedList = (await request('GET', '/api/v1/canopy/automations'))
    .body.automations;
  assert.equal(publishedList.length, 1);
  assert.equal(publishedList[0].id, id);
  assert.deepEqual(publishedList[0].publicShare, publicShare);
  assert.equal(publicShare.externalId, '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b');
  const publicPath = `/api/v1/canopy/public-shares/automations/${publicShare.externalId}`;
  assert.deepEqual(
    (await request('GET', basePath)).body.publicShare,
    publicShare,
  );
  assert.equal(
    (await request('GET', publicPath, undefined, false)).body.entity,
    'automation',
  );
  const updated = { ...automation, description: 'Updated description' };
  assert.deepEqual(
    (await request('PUT', basePath, { automation: updated })).body.automation,
    updated,
  );
  const staleShare = { ...publicShare, upToDate: false };
  assert.deepEqual(
    (await request('GET', basePath)).body.publicShare,
    staleShare,
  );
  assert.deepEqual(
    (await request('PUT', basePath, { automation: updated })).body.publicShare,
    staleShare,
  );
  const stalePublicResponse = (
    await request('GET', publicPath, undefined, false)
  ).body;
  assert.deepEqual(stalePublicResponse.automation, automation);
  assert.equal(stalePublicResponse.contentHash, publicShare.pinnedContentHash);
  const republished = (await request('POST', `${basePath}/public-share`)).body
    .publicShare;
  assert.equal(republished.upToDate, true);
  assert.notEqual(republished.pinnedContentHash, publicShare.pinnedContentHash);
  assert.deepEqual(
    (await request('GET', publicPath, undefined, false)).body.automation,
    updated,
  );
  assert.equal(
    (await request('GET', basePath)).body.publicShare.upToDate,
    true,
  );
  assert.equal(
    (await request('DELETE', `${basePath}/public-share`)).status,
    204,
  );
  assert.equal((await request('GET', basePath)).body.publicShare, null);
  assert.equal(
    (await request('DELETE', `${basePath}/public-share`)).status,
    204,
  );
  assert.equal((await request('POST', `${basePath}/public-share`)).status, 200);
  assert.equal((await request('DELETE', basePath)).status, 204);
});

test('catalog placeholders use context catalogs and persist recorded dismissals without sockets', async () => {
  resetAll();
  const key = 'csk_catalog_rows_unit';
  registerScenario(key, {
    cloud: {
      orgProjects: {
        'org:a': [
          {
            id: 'project',
            listed: true,
            preference: 'FOLLOW_DEFAULTS',
            defaultListed: true,
            capabilities: { use: true },
          },
        ],
      },
    },
  });
  async function request(method, pathname, body) {
    const input = Readable.from(body ? [JSON.stringify(body)] : []);
    input.method = method;
    input.headers = { authorization: `Bearer ${key}` };
    let payload;
    let status;
    const headers = {};
    const response = {
      setHeader(name, value) {
        headers[name] = value;
      },
      writeHead(code) {
        status = code;
      },
      end(data) {
        payload = JSON.parse(data);
      },
    };
    assert.equal(
      await handleCloudRequest(
        input,
        response,
        new URL(pathname, 'http://mock.test'),
      ),
      true,
    );
    assert.equal(status, 200);
    return { payload, headers };
  }
  try {
    for (const prefix of ['/api/v1', '/api/v1/custom-brand']) {
      const result = await request(
        'GET',
        `${prefix}/projects/catalog?context=org:a`,
      );
      assert.equal(result.payload.data[0].id, 'project');
      assert.equal(result.headers.ETag, '"r1"');
      assert.deepEqual(
        (await request('GET', `${prefix}/projects/catalog?context=personal`))
          .payload.data,
        [],
      );
    }
    const dismissed = await request(
      'PUT',
      '/api/v1/projects/project/preference',
      { preference: 'DISMISSED' },
    );
    assert.equal(dismissed.payload.listed, false);
    assert.equal(dismissed.payload.preference, 'DISMISSED');
    assert.equal(getScenarioActivity(key).orgProjectPreferencePut, 1);
    assert.equal(
      (await request('GET', '/api/v1/projects/catalog?context=org:a')).payload
        .data[0].listed,
      false,
    );
  } finally {
    resetAll();
  }
});

async function setupRequest(key, pathname, body, method = 'POST') {
  const input = Readable.from(body ? [JSON.stringify(body)] : []);
  input.method = method;
  input.headers = { authorization: `Bearer ${key}` };
  let status;
  let payload;
  const handled = await handleCloudRequest(
    input,
    {
      writeHead(code) {
        status = code;
      },
      end(data) {
        payload = data ? JSON.parse(data) : undefined;
      },
    },
    new URL(pathname, 'http://mock.test'),
  );
  assert.equal(handled, true, `Missing ${method} ${pathname}`);
  return { status, payload };
}

// Proves a scenario delay holds the route without measuring wall-clock time:
// Node timers run on libuv's cached loop clock, so a `setTimeout(40)` can
// measure as 39ms with `Date.now()`. A probe for half the delay always fires
// first, and an undelayed route has already settled by then.
async function assertRouteHeld(pending, holdMs, message) {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  assert.equal(settled, false, message);
  return pending;
}

test('organization default Chats creates isolated state for an unregistered credential', async () => {
  resetAll();
  const key = 'csk_unregistered_default_chats';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  try {
    assert.equal(getScenario(key), DEFAULT_SCENARIO);
    // Activity recorded before the ensure (for example during sign-in) must
    // survive the scenario the ensure registers for this credential.
    recordScenarioActivity(key, 'entitlementsRead');
    const first = await setupRequest(key, '/api/v1/projects/default-chats', {
      organizationId,
    });
    const repeated = await setupRequest(key, '/api/v1/projects/default-chats', {
      organizationId,
    });
    assert.equal(first.status, 200);
    assert.deepEqual(repeated.payload, first.payload);
    assert.equal(getScenarioActivity(key).orgDefaultChatsEnsure, 2);
    assert.equal(getScenarioActivity(key).entitlementsRead, 1);
    assert.equal(getScenario('csk_other_unregistered'), DEFAULT_SCENARIO);
    assert.deepEqual(DEFAULT_SCENARIO, {});
    assert.equal(
      getScenario(key).cloud.orgDefaultChats[organizationId].id,
      first.payload.id,
    );
  } finally {
    resetAll();
  }
});

test('organization default Chats ensure feeds the normal claim and complete routes', async () => {
  resetAll();
  const key = 'csk_default_chats';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  registerScenario(key, { cloud: {} });
  try {
    const ensured = await setupRequest(key, '/api/v1/projects/default-chats', {
      organizationId,
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.payload.kind, 'COWORK');
    assert.equal(ensured.payload.purpose, 'default-chats');

    const claim = await setupRequest(
      key,
      `/api/v1/projects/${ensured.payload.id}/instances/claim`,
      {
        deviceId: 'device',
        installationGeneration: 1,
        localWorkspaceId: `cowork-org-${organizationId}`,
        idempotencyKey: 'stable',
      },
    );
    assert.equal(claim.status, 200);
    const completed = await setupRequest(
      key,
      `/api/v1/projects/instances/${claim.payload.instanceId}/complete`,
      {
        operationId: claim.payload.operationId,
        fencingGeneration: claim.payload.fencingGeneration,
        outcome: 'ready',
      },
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.payload.state, 'READY');
    // Totals include the default Chats claim; the per-project counters let
    // organization-project specs exclude it (#4159).
    assert.deepEqual(getScenarioActivity(key), {
      orgDefaultChatsEnsure: 1,
      orgProjectClaim: 1,
      [`orgProjectClaim:${ensured.payload.id}`]: 1,
      orgProjectComplete: 1,
      [`orgProjectComplete:${ensured.payload.id}`]: 1,
    });
    getScenario(key).cloud.orgProjects = {
      [`org:${organizationId}`]: [
        { id: 'code-project', purpose: 'project', instance: null },
      ],
    };
    await setupRequest(
      key,
      '/api/v1/projects/code-project/instances/claim',
      {},
    );
    const activity = getScenarioActivity(key);
    assert.equal(activity.orgProjectClaim, 2);
    assert.equal(activity['orgProjectClaim:code-project'], 1);
    assert.equal(activity[`orgProjectClaim:${ensured.payload.id}`], 1);
  } finally {
    resetAll();
  }
});

test('a member multi-repo project gathers organization repositories once per local project (CAN-3532)', async () => {
  resetAll();
  const key = 'csk_member_multi_repo';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const repository = (name) => ({
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name,
    providerRepoId: name,
    defaultBranch: 'main',
    verification: 'VERIFIED',
  });
  registerScenario(key, {
    cloud: {
      orgProjects: {
        [`org:${organizationId}`]: [
          { id: 'web', organizationId, repository: repository('web') },
          { id: 'api', organizationId, repository: repository('api') },
        ],
        'org:other': [
          {
            id: 'billing',
            organizationId: 'other',
            repository: repository('billing'),
          },
        ],
      },
    },
  });
  try {
    const body = {
      organizationId,
      name: 'Platform',
      localWorkspaceId: 'platform',
      repositoryProjectIds: ['web', 'api'],
    };
    const created = await setupRequest(
      key,
      '/api/v1/projects/member/multi-repo',
      body,
    );
    assert.equal(created.status, 200);
    assert.equal(created.payload.topology, 'multi-repo');
    assert.equal(created.payload.visibility, 'private');
    assert.equal(created.payload.repository.name, 'web');
    const again = await setupRequest(
      key,
      '/api/v1/projects/member/multi-repo',
      body,
    );
    assert.equal(again.payload.id, created.payload.id);
    assert.equal(
      getScenario(key).cloud.orgProjects[`org:${organizationId}`].length,
      3,
    );
    const foreign = await setupRequest(
      key,
      '/api/v1/projects/member/multi-repo',
      {
        ...body,
        localWorkspaceId: 'mixed',
        repositoryProjectIds: ['web', 'billing'],
      },
    );
    assert.equal(foreign.status, 409);
    assert.equal(foreign.payload.code, 'repository_mismatch');
    assert.equal(getScenarioActivity(key).orgMemberMultiRepoCreate, 3);

    // CAN-3546: Create new starts empty, and settings replace the list.
    const empty = await setupRequest(
      key,
      '/api/v1/projects/member/multi-repo',
      { ...body, localWorkspaceId: 'empty', repositoryProjectIds: [] },
    );
    assert.equal(empty.status, 200);
    assert.equal(empty.payload.repository, null);
    const path = `/api/v1/projects/member/multi-repo/${empty.payload.id}`;
    const updated = await setupRequest(
      key,
      path,
      { repositoryProjectIds: ['web', 'api'] },
      'PATCH',
    );
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.payload.repositoryProjectIds, ['web', 'api']);
    assert.equal(updated.payload.repository.name, 'web');
    const outside = await setupRequest(
      key,
      path,
      { repositoryProjectIds: ['web', 'billing'] },
      'PATCH',
    );
    assert.equal(outside.status, 409);
    assert.equal(outside.payload.code, 'repository_mismatch');
    const missing = await setupRequest(
      key,
      '/api/v1/projects/member/multi-repo/web',
      { repositoryProjectIds: [] },
      'PATCH',
    );
    assert.equal(missing.status, 404);
    assert.equal(getScenarioActivity(key).orgMemberMultiRepoUpdate, 3);
  } finally {
    resetAll();
  }
});

test('organization project claims can be forced to fail for setup recovery coverage', async () => {
  resetAll();
  const key = 'csk_project_claim_failure';
  const projectId = '33333333-3333-4333-8333-333333333345';
  registerScenario(key, {
    cloud: {
      orgProjectClaimStatus: 503,
      orgProjects: {
        'org:a': [{ id: projectId, instance: null }],
      },
    },
  });
  try {
    const claim = await setupRequest(
      key,
      `/api/v1/projects/${projectId}/instances/claim`,
      {
        deviceId: 'device',
        installationGeneration: 1,
        localWorkspaceId: `cowork-project-${projectId}`,
        idempotencyKey: 'stable',
      },
    );
    assert.equal(claim.status, 503);
    assert.deepEqual(claim.payload, { error: 'Project setup unavailable' });
    assert.deepEqual(getScenarioActivity(key), {
      orgProjectClaim: 1,
      [`orgProjectClaim:${projectId}`]: 1,
    });
  } finally {
    resetAll();
  }
});

test('a lapsed claim is reclaimed exactly, and a superseded one is refused (CAN-3129)', async () => {
  resetAll();
  const key = 'csk_project_reclaim';
  const projectId = '33333333-3333-4333-8333-333333333346';
  const claimBody = {
    deviceId: 'device',
    installationGeneration: 1,
    localWorkspaceId: 'setup-repo',
    idempotencyKey: 'first',
  };
  registerScenario(key, {
    cloud: {
      orgProjectClaimLapses: 1,
      orgProjects: { 'org:a': [{ id: projectId, instance: null }] },
    },
  });
  try {
    const claimPath = `/api/v1/projects/${projectId}/instances/claim`;
    const first = (await setupRequest(key, claimPath, claimBody)).payload;
    const completePath = `/api/v1/projects/instances/${first.instanceId}/complete`;
    const lapsed = await setupRequest(key, completePath, {
      operationId: first.operationId,
      fencingGeneration: first.fencingGeneration,
      outcome: 'ready',
    });
    assert.equal(lapsed.status, 409);
    assert.equal(lapsed.payload.code, 'conflict');
    const target = {
      instanceId: first.instanceId,
      operationId: first.operationId,
      fencingGeneration: first.fencingGeneration,
    };
    const otherWorkspace = await setupRequest(key, claimPath, {
      ...claimBody,
      idempotencyKey: 'other',
      localWorkspaceId: 'elsewhere',
      reclaim: target,
    });
    assert.equal(otherWorkspace.status, 409);
    const reclaimed = await setupRequest(key, claimPath, {
      ...claimBody,
      idempotencyKey: 'reclaim',
      reclaim: target,
    });
    assert.equal(reclaimed.status, 200);
    assert.equal(reclaimed.payload.instanceId, first.instanceId);
    assert.equal(
      reclaimed.payload.fencingGeneration,
      first.fencingGeneration + 1,
    );
    assert.notEqual(reclaimed.payload.operationId, first.operationId);
    // The old fence is gone for good: naming it again is a supersede.
    const stale = await setupRequest(key, claimPath, {
      ...claimBody,
      idempotencyKey: 'stale',
      reclaim: target,
    });
    assert.equal(stale.status, 409);
    const ready = await setupRequest(key, completePath, {
      operationId: reclaimed.payload.operationId,
      fencingGeneration: reclaimed.payload.fencingGeneration,
      outcome: 'ready',
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.payload.state, 'READY');
    assert.equal(getScenarioActivity(key).orgProjectReclaim, 3);
  } finally {
    resetAll();
  }
});

test('a supersede before completion refuses the reclaim (CAN-3129)', async () => {
  resetAll();
  const key = 'csk_project_supersede';
  const projectId = '33333333-3333-4333-8333-333333333347';
  registerScenario(key, {
    cloud: {
      orgProjectSupersedeOnComplete: true,
      orgProjects: { 'org:a': [{ id: projectId, instance: null }] },
    },
  });
  try {
    const claimBody = {
      deviceId: 'device',
      installationGeneration: 1,
      localWorkspaceId: 'setup-repo',
      idempotencyKey: 'first',
    };
    const claimPath = `/api/v1/projects/${projectId}/instances/claim`;
    const first = (await setupRequest(key, claimPath, claimBody)).payload;
    const gone = await setupRequest(
      key,
      `/api/v1/projects/instances/${first.instanceId}/complete`,
      {
        operationId: first.operationId,
        fencingGeneration: first.fencingGeneration,
        outcome: 'ready',
      },
    );
    assert.equal(gone.status, 409);
    assert.equal(gone.payload.code, 'conflict');
    const refused = await setupRequest(key, claimPath, {
      ...claimBody,
      idempotencyKey: 'reclaim',
      reclaim: {
        instanceId: first.instanceId,
        operationId: first.operationId,
        fencingGeneration: first.fencingGeneration,
      },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.payload.code, 'conflict');
  } finally {
    resetAll();
  }
});

test('records converted-project activity moves and returns (CAN-3418)', async () => {
  resetAll();
  const key = 'csk_activity_transfer_routes';
  registerScenario(key, { cloud: { orgProjects: {} } });
  try {
    const body = { localWorkspaceId: 'payments' };
    const moved = await setupRequest(
      key,
      '/api/v1/projects/project/activity-transfer',
      body,
    );
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.payload, {
      outcome: 'nothing-to-move',
      transferId: null,
      counts: null,
    });
    const returned = await setupRequest(
      key,
      '/api/v1/projects/project/activity-transfer/reverse',
      body,
    );
    assert.equal(returned.status, 200);
    assert.equal(returned.payload.outcome, 'nothing-to-return');
    const activity = getScenarioActivity(key);
    assert.equal(activity.orgProjectActivityMove, 1);
    assert.equal(activity['orgProjectActivityMove:project:payments'], 1);
    assert.equal(activity.orgProjectActivityReturn, 1);
    assert.equal(activity['orgProjectActivityReturn:project:payments'], 1);
  } finally {
    resetAll();
  }
});

test('records activity repairs filed under the wrong scope (CAN-3517)', async () => {
  resetAll();
  const key = 'csk_activity_repair_routes';
  registerScenario(key, { cloud: { orgProjects: {} } });
  try {
    const moved = await setupRequest(
      key,
      '/api/v1/projects/project/activity-transfer',
      { localWorkspaceId: 'org-work', withheldKinds: ['plans', 'summaries'] },
    );
    assert.equal(moved.status, 200);
    const returned = await setupRequest(
      key,
      '/api/v1/projects/personal/activity-return',
      { localWorkspaceId: 'notes' },
    );
    assert.equal(returned.status, 200);
    assert.deepEqual(returned.payload, {
      outcome: 'nothing-to-return',
      transferIds: [],
      counts: null,
    });
    const activity = getScenarioActivity(key);
    assert.equal(
      activity[
        'orgProjectActivityMove:project:org-work:withheld=plans,summaries'
      ],
      1,
    );
    assert.equal(activity.orgPersonalActivityReturn, 1);
    assert.equal(activity['orgPersonalActivityReturn:notes'], 1);
  } finally {
    resetAll();
  }
});

for (const prefix of ['/api/v1', '/api/v1/custom-brand']) {
  test(`project setup claim, completion and detach update the catalog (${prefix})`, async () => {
    resetAll();
    const key = 'csk_setup_routes';
    const project = {
      id: 'project',
      instance: null,
      capabilities: { use: true },
    };
    registerScenario(key, { cloud: { orgProjects: { 'org:a': [project] } } });
    try {
      const claimBody = {
        deviceId: 'device',
        installationGeneration: 0,
        localWorkspaceId: 'repo',
        idempotencyKey: 'key',
      };
      const claimed = await setupRequest(
        key,
        `${prefix}/projects/project/instances/claim`,
        claimBody,
      );
      assert.equal(claimed.status, 200);
      assert.match(claimed.payload.instanceId, /^[a-f0-9-]{36}$/);
      assert.match(claimed.payload.operationId, /^[a-f0-9-]{36}$/);
      assert.equal(claimed.payload.state, 'CLAIMED');
      const replay = await setupRequest(
        key,
        `${prefix}/projects/project/instances/claim`,
        claimBody,
      );
      assert.deepEqual(replay, claimed);
      const completePath = `${prefix}/projects/instances/${claimed.payload.instanceId}/complete`;
      const completeBody = {
        operationId: claimed.payload.operationId,
        fencingGeneration: claimed.payload.fencingGeneration,
        outcome: 'ready',
      };
      assert.equal(
        (
          await setupRequest(key, completePath, {
            ...completeBody,
            fencingGeneration: -1,
          })
        ).status,
        409,
      );
      const completed = await setupRequest(key, completePath, completeBody);
      assert.equal(completed.status, 200);
      assert.equal(completed.payload.state, 'READY');
      assert.equal(
        (
          await setupRequest(
            key,
            `${prefix}/projects/project/instances/claim`,
            claimBody,
          )
        ).payload.state,
        'READY',
      );
      const detached = await setupRequest(
        key,
        `${prefix}/projects/instances/${claimed.payload.instanceId}/detach`,
      );
      assert.equal(detached.status, 200);
      assert.equal(detached.payload.state, 'DETACHED');
      assert.equal(getScenarioActivity(key).orgProjectClaim, 3);
      assert.equal(getScenarioActivity(key).orgProjectComplete, 2);
      assert.equal(getScenarioActivity(key).orgProjectDetach, 1);
      assert.equal(getScenarioActivity(key)['orgProjectClaim:project'], 3);
      assert.equal(getScenarioActivity(key)['orgProjectComplete:project'], 2);
      assert.equal(getScenarioActivity(key)['orgProjectDetach:project'], 1);
      assert.equal(
        (
          await setupRequest(
            key,
            `${prefix}/projects/missing/instances/claim`,
            claimBody,
          )
        ).status,
        404,
      );
      assert.equal(
        (await setupRequest(key, `${prefix}/projects/instances/missing/detach`))
          .status,
        404,
      );
    } finally {
      resetAll();
    }
  });
}

test('materializing catalog refresh can hold the pre-promotion cancellation window', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  resetAll();
  const key = 'csk_setup_refresh_delay';
  registerScenario(key, {
    cloud: {
      orgProjectValidationDelayMs: 40,
      orgProjects: {
        'org:a': [
          {
            id: 'project',
            instance: { id: 'instance', state: 'CLAIMED' },
          },
        ],
      },
    },
  });
  const input = Readable.from([]);
  input.method = 'GET';
  input.headers = { authorization: `Bearer ${key}` };
  try {
    let completed = false;
    const pending = handleCloudRequest(
      input,
      { setHeader() {}, writeHead() {}, end() {} },
      new URL('/api/v1/projects/catalog?context=org:a', 'http://mock.test'),
    ).then((handled) => {
      completed = true;
      return handled;
    });
    await new Promise(setImmediate);
    t.mock.timers.tick(39);
    await new Promise(setImmediate);
    assert.equal(completed, false);
    t.mock.timers.tick(1);
    assert.equal(await pending, true);
    assert.equal(completed, true);
    assert.equal(getScenarioActivity(key).orgProjectValidationRead, 1);
  } finally {
    resetAll();
  }
});

test('setup claim can hold the running row before cloning', async () => {
  resetAll();
  const key = 'csk_setup_claim_delay';
  registerScenario(key, {
    cloud: {
      orgProjectClaimDelayMs: 40,
      orgProjects: { 'org:a': [{ id: 'project', instance: null }] },
    },
  });
  try {
    const response = await assertRouteHeld(
      setupRequest(key, '/api/v1/projects/project/instances/claim'),
      20,
      'Expected setup claim delay',
    );
    assert.equal(response.status, 200);
    assert.equal(getScenarioActivity(key).orgProjectClaim, 1);
  } finally {
    resetAll();
  }
});

test('the Ledger mirror registers scopes and applies contiguous pushes', async () => {
  resetAll();
  const key = 'csk_ledger_mirror_unit';
  const ledgerId = '00000000-0000-4000-8000-0000000000f1';
  registerScenario(key, {
    cloud: { account: { id: '00000000-0000-4000-8000-0000000000c1' } },
  });
  const { server, base } = await startServer();
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const events = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, index) => ({
      scopeSequence: String(from + index),
    }));

  try {
    const account = await (
      await fetch(`${base}/api/v1/canopy/account`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).json();
    assert.equal(account.account.id, '00000000-0000-4000-8000-0000000000c1');

    const registered = await post('/api/v1/ledger/scopes/register', {
      ledgerId,
      audience: { kind: 'private' },
    });
    assert.equal(registered.status, 200);
    assert.deepEqual(await registered.json(), {
      ledgerId,
      writerEpoch: '1',
      acknowledgedSequence: '0',
      audience: { kind: 'private' },
    });

    const pushed = await post('/api/v1/ledger/sync/push', {
      ledgerId,
      acknowledgedSequence: '0',
      events: events(1, 3),
    });
    assert.deepEqual(await pushed.json(), {
      ledgerId,
      acknowledgedSequence: '3',
      applied: 3,
      replayed: 0,
    });
    // A replay of what it holds, then the next event.
    const replayed = await post('/api/v1/ledger/sync/push', {
      ledgerId,
      acknowledgedSequence: '0',
      events: events(1, 4),
    });
    assert.deepEqual(await replayed.json(), {
      ledgerId,
      acknowledgedSequence: '4',
      applied: 1,
      replayed: 3,
    });
    const gap = await post('/api/v1/ledger/sync/push', {
      ledgerId,
      acknowledgedSequence: '4',
      events: events(6, 6),
    });
    assert.equal(gap.status, 409);
    assert.equal((await gap.json()).error.code, 'ledger_sequence_gap');
    assert.deepEqual(getScenarioActivity(key), {
      ledgerRegister: 1,
      ledgerPush: 3,
      ledgerEvents: 4,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('the Ledger mirror answers as the ingest switch, a prohibition and a superseded writer do', async () => {
  resetAll();
  const key = 'csk_ledger_mirror_refusals_unit';
  const ledgerId = '00000000-0000-4000-8000-0000000000f2';
  const { server, base } = await startServer();
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  try {
    registerScenario(key, { cloud: { ledger: { ingest: 'disabled' } } });
    const disabled = await post('/api/v1/ledger/scopes/register', {
      ledgerId,
      audience: { kind: 'private' },
    });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.headers.get('retry-after'), '1');
    assert.equal((await disabled.json()).error.code, 'ledger_ingest_disabled');

    registerScenario(key, { cloud: { ledger: { ingest: 'prohibited' } } });
    const prohibited = await post('/api/v1/ledger/scopes/register', {
      ledgerId,
      audience: { kind: 'private' },
    });
    assert.equal(prohibited.status, 403);
    assert.equal(
      (await prohibited.json()).error.code,
      'ledger_scope_prohibited',
    );

    registerScenario(key, { cloud: { ledger: { push: 'stale_writer' } } });
    await post('/api/v1/ledger/scopes/register', {
      ledgerId,
      audience: { kind: 'private' },
    });
    const stale = await post('/api/v1/ledger/sync/push', {
      ledgerId,
      acknowledgedSequence: '0',
      events: [{ scopeSequence: '1' }],
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'ledger_stale_writer');
  } finally {
    server.close();
    resetAll();
  }
});

test("the Ledger mirror's reads search each audience and read entries", async () => {
  resetAll();
  const key = 'csk_ledger_mirror_reads_unit';
  const row = (entryId, updatedAt, extra = {}) => ({
    entryId,
    updatedAt,
    scopeArchived: false,
    ...extra,
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  const search = (body) =>
    fetch(`${base}/api/v1/ledger/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  try {
    registerScenario(key, {
      cloud: {
        ledger: {
          feed: {
            mine: [
              row('older', '2026-10-01T10:00:00.000Z'),
              row('newer', '2026-10-02T10:00:00.000Z'),
              row('archived', '2026-10-03T10:00:00.000Z', {
                scopeArchived: true,
              }),
            ],
            teammates: [row('teammate', '2026-10-01T12:00:00.000Z')],
            actors: [{ actorId: 'a', kind: 'user', displayName: 'You' }],
            entries: { newer: { entry: { entryId: 'newer' } } },
          },
        },
      },
    });

    const mine = await (await search({ audience: 'mine' })).json();
    assert.deepEqual(
      mine.entries.map((entry) => entry.entryId),
      ['newer', 'older'],
    );
    assert.equal(mine.hasMore, false);
    const all = await (
      await search({ audience: 'mine', includeArchived: true })
    ).json();
    assert.deepEqual(
      all.entries.map((entry) => entry.entryId),
      ['archived', 'newer', 'older'],
    );
    const teammates = await (await search({ audience: 'teammates' })).json();
    assert.deepEqual(
      teammates.entries.map((entry) => entry.entryId),
      ['teammate'],
    );
    assert.equal(getScenarioActivity(key).ledgerSearch, 3);

    const entry = await fetch(`${base}/api/v1/ledger/entries/newer`, {
      headers,
    });
    assert.equal(entry.status, 200);
    assert.equal((await entry.json()).entry.entryId, 'newer');
    const missing = await fetch(`${base}/api/v1/ledger/entries/gone`, {
      headers,
    });
    assert.equal(missing.status, 404);

    // Filters apply as the mirror applies them.
    registerScenario(key, {
      cloud: {
        ledger: {
          feed: {
            mine: [
              row('task', '2026-10-02T10:00:00.000Z', {
                type: 'TASK',
                status: 'IN_PROGRESS',
                title: 'Parser recovery',
                content: 'Keep partial events.',
                author: { kind: 'user' },
                owner: { kind: 'chat' },
                source: { kind: 'mine' },
              }),
              row('decision', '2026-09-20T10:00:00.000Z', {
                type: 'DECISION',
                status: 'INFO',
                title: 'One writer',
                content: 'The cache has a single parser writer.',
                highlights: ['No races'],
                author: { kind: 'user' },
                owner: { kind: 'user' },
                source: { kind: 'mine' },
              }),
            ],
            teammates: [
              row('theirs', '2026-10-02T12:00:00.000Z', {
                type: 'TASK',
                status: 'TODO',
                title: 'Parser docs',
                author: { kind: 'user' },
                owner: { kind: 'user' },
                source: { kind: 'teammate' },
              }),
            ],
          },
        },
      },
    });
    const ids = async (body) =>
      (await (await search(body)).json()).entries.map((entry) => entry.entryId);
    assert.deepEqual(await ids({ audience: 'mine', query: 'pars' }), [
      'task',
      'decision',
    ]);
    assert.deepEqual(await ids({ audience: 'mine', query: 'no rac' }), [
      'decision',
    ]);
    assert.deepEqual(await ids({ audience: 'mine', query: 'arser' }), []);
    assert.deepEqual(await ids({ audience: 'mine', types: ['DECISION'] }), [
      'decision',
    ]);
    assert.deepEqual(
      await ids({ audience: 'mine', statuses: ['IN_PROGRESS', 'BLOCKED'] }),
      ['task'],
    );
    assert.deepEqual(
      await ids({
        audience: 'mine',
        updatedAfter: '2026-10-01T00:00:00.000Z',
      }),
      ['task'],
    );
    assert.deepEqual(await ids({ audience: 'mine', owner: 'self' }), [
      'decision',
    ]);
    assert.deepEqual(await ids({ audience: 'teammates', author: 'self' }), []);

    registerScenario(key, { cloud: { ledger: { feed: 'unavailable' } } });
    const down = await search({ audience: 'mine' });
    assert.equal(down.status, 503);
  } finally {
    server.close();
    resetAll();
  }
});

test('a member repository refresh lists what GitHub created since (CAN-3489)', async () => {
  resetAll();
  const key = 'csk_repository_refresh';
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const context = `org:${organizationId}`;
  const created = { id: 'fresh', name: 'fresh' };
  registerScenario(key, {
    cloud: {
      orgProjects: { [context]: [{ id: 'old', name: 'old' }] },
      orgProjectRepositoryRefresh: {
        createdRepositories: { [context]: [created] },
      },
    },
  });
  try {
    for (let open = 0; open < 2; open += 1) {
      const refreshed = await setupRequest(
        key,
        '/api/v1/projects/repositories/refresh',
        { organizationId },
      );
      assert.equal(refreshed.status, 200);
      assert.deepEqual(refreshed.payload, { status: 'refreshed' });
    }
    // Listed once, however often the dialog opens.
    assert.deepEqual(
      getScenario(key).cloud.orgProjects[context].map((row) => row.id),
      ['old', 'fresh'],
    );
    assert.equal(getScenarioActivity(key).orgProjectRepositoryRefresh, 2);

    registerScenario(key, {
      cloud: { orgProjectRepositoryRefresh: { status: 'failed' } },
    });
    const failed = await setupRequest(
      key,
      '/api/v1/projects/repositories/refresh',
      { organizationId },
    );
    assert.deepEqual(failed.payload, { status: 'failed' });
  } finally {
    resetAll();
  }
});

test('telemetry ingest records destinations only for opted-in scenarios', async () => {
  resetAll();
  const key = 'csk_can3515_ingest_recorder';
  const { server, base } = await startServer();
  const post = (organizationId) =>
    fetch(`${base}/api/v1/canopy/telemetry/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        shareScope: organizationId ? 'organization' : 'private',
        ...(organizationId ? { organizationId } : {}),
        workspace: {
          clientLocalId: 'ws-1',
          worktrees: [
            {
              clientLocalId: 'wt-1-scoped',
              sourceClientLocalId: 'wt-1',
              turns: [{ clientTurnId: 'turn-1' }],
            },
          ],
        },
      }),
    });

  try {
    assert.equal((await post('org-1')).status, 404);
    assert.deepEqual(getScenarioActivity(key), {});

    registerScenario(key, { cloud: { recordTelemetryIngest: true } });
    const response = await post('org-1');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.workspace.worktrees[0].clientLocalId, 'wt-1-scoped');
    assert.equal(
      payload.workspace.worktrees[0].turns[0].clientTurnId,
      'turn-1',
    );
    assert.equal((await post(undefined)).status, 200);
    assert.deepEqual(getScenarioActivity(key), {
      'telemetryIngest:organization:org-1:wt-1': 1,
      'telemetryIngestTurn:organization:org-1:wt-1:turn-1': 1,
      'telemetryIngest:private:none:wt-1': 1,
      'telemetryIngestTurn:private:none:wt-1:turn-1': 1,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('product activity turns are recorded only for scenarios that opt in', async () => {
  resetAll();
  const key = 'csk_can3561_product_activity';
  const quietKey = 'csk_can3561_product_activity_quiet';
  // sha256('turn-1'), the vector shared with the protocol and web tests.
  const turnKey =
    '974cad2dd603827b06e9e6affa3de03db5af2c12c045db679a7b1bef42b41a1c';
  registerScenario(key, { cloud: { recordProductActivity: true } });
  registerScenario(quietKey, {});
  const { server, base } = await startServer();
  const post = (bearer, body, headers = {}) =>
    fetch(`${base}/api/v1/product-activity/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  try {
    const owned = await post(
      key,
      { turnKey, organizationExternalId: 'org-1' },
      { 'x-canopy-client': 'desktop' },
    );
    assert.equal(owned.status, 202);
    assert.deepEqual(await owned.json(), { accepted: true });
    // A repeat is counted, so a spec can assert exactly one signal per turn.
    await post(
      key,
      { turnKey, organizationExternalId: 'org-1' },
      { 'x-canopy-client': 'desktop' },
    );
    // No organization and no declared surface are both recorded as `none`.
    assert.equal((await post(key, { turnKey })).status, 202);
    assert.deepEqual(getScenarioActivity(key), {
      [`productActivityTurn:desktop:org-1:${turnKey}`]: 2,
      [`productActivityTurn:none:none:${turnKey}`]: 1,
    });

    // Without the opt-in the route stays unhandled, like an older server.
    assert.equal((await post(quietKey, { turnKey })).status, 404);
    assert.deepEqual(getScenarioActivity(quietKey), {});
  } finally {
    server.close();
    resetAll();
  }
});

test('daily-drip defaults to a decided, opted-in user and stays stateless', async () => {
  resetAll();
  const { server, base } = await startServer();
  const headers = {
    authorization: 'Bearer csk_daily_drip_default_e2e',
    'content-type': 'application/json',
  };

  try {
    const read = await fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      headers,
    });
    assert.equal(read.status, 200);
    const preference = await read.json();
    assert.equal(preference.enabled, true);
    assert.equal(typeof preference.decidedAt, 'string');
    assert.equal(preference.capCredits, 10);

    const invalid = await fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: 'true' }),
    });
    assert.equal(invalid.status, 400);

    const unauthenticated = await fetch(`${base}/api/v1/ai-credits/daily-drip`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    server.close();
    resetAll();
  }
});

test('daily-drip PUT persists the choice and credits the balance once per day', async () => {
  resetAll();
  const key = 'csk_daily_drip_undecided_e2e';
  registerScenario(key, {
    cloud: {
      dailyCreditDrip: { enabled: false, decidedAt: null, capCredits: 10 },
      aiCreditsBalance: {
        credits: 0,
        eligible: false,
        dailyDripEnabled: false,
      },
    },
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  const put = (enabled) =>
    fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled }),
    }).then((response) => response.json());

  try {
    const before = await fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      headers,
    }).then((response) => response.json());
    assert.equal(before.decidedAt, null);

    const enabled = await put(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.granted, 10);
    assert.equal(enabled.balanceCredits, 10);

    const balance = await fetch(`${base}/api/v1/ai-credits/balance`, {
      headers,
    }).then((response) => response.json());
    assert.equal(balance.credits, 10);
    assert.equal(balance.eligible, true);
    assert.equal(balance.dailyDripEnabled, true);

    const after = await fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      headers,
    }).then((response) => response.json());
    assert.equal(after.enabled, true);
    assert.equal(typeof after.decidedAt, 'string');

    const disabled = await put(false);
    assert.equal(disabled.granted, 0);
    const reEnabled = await put(true);
    assert.equal(reEnabled.granted, 0, 'no second grant on the same day');

    assert.deepEqual(getScenarioActivity(key), {
      dailyCreditDripRead: 2,
      dailyCreditDripEnable: 2,
      dailyCreditDripDisable: 1,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('daily-drip grantFails saves the choice but leaves the balance at 0', async () => {
  resetAll();
  const key = 'csk_daily_drip_grant_fails_e2e';
  registerScenario(key, {
    cloud: {
      dailyCreditDrip: {
        enabled: false,
        decidedAt: null,
        capCredits: 10,
        grantFails: true,
      },
      aiCreditsBalance: {
        credits: 0,
        eligible: false,
        dailyDripEnabled: false,
      },
    },
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };

  try {
    const saved = await fetch(`${base}/api/v1/ai-credits/daily-drip`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: true }),
    }).then((response) => response.json());
    assert.equal(saved.enabled, true);
    assert.equal(saved.granted, 0);
    assert.equal(saved.balanceCredits, 0);

    const balance = await fetch(`${base}/api/v1/ai-credits/balance`, {
      headers,
    }).then((response) => response.json());
    assert.equal(balance.credits, 0);
    assert.equal(balance.eligible, false);
    assert.equal(balance.dailyDripEnabled, true);
  } finally {
    server.close();
    resetAll();
  }
});

test('Labs choices isolate accounts, retain retired ids and expose deterministic failures', async () => {
  resetAll();
  const key = 'csk_labs_choices';
  registerScenario(key, {
    cloud: {
      experiments: {
        choices: { retired: true, 'stacked-notifications': false },
      },
    },
  });
  const { server, base } = await startServer();
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'x-labs-experiments-version': '2',
  };
  try {
    assert.equal(
      (await fetch(`${base}/api/v1/experiments/choices`)).status,
      401,
    );
    assert.deepEqual(
      await (
        await fetch(`${base}/api/v1/experiments/choices`, { headers })
      ).json(),
      {
        choices: migrateExtractedLabsChoices({
          retired: true,
          'stacked-notifications': false,
        }),
      },
    );
    const put = await fetch(`${base}/api/v1/experiments/choices/early-access`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(
      await (
        await fetch(`${base}/api/v1/experiments/choices`, { headers })
      ).json(),
      {
        choices: {
          ...migrateExtractedLabsChoices({
            retired: true,
            'stacked-notifications': false,
          }),
          'early-access': true,
        },
      },
    );
    assert.deepEqual(
      await (
        await fetch(`${base}/api/v1/experiments/choices`, {
          headers: {
            authorization: 'Bearer csk_labs_other',
            'x-labs-experiments-version': '2',
          },
        })
      ).json(),
      { choices: migrateExtractedLabsChoices({}) },
    );
    const otherHeaders = {
      authorization: 'Bearer csk_labs_other',
      'content-type': 'application/json',
      'x-labs-experiments-version': '2',
    };
    assert.equal(
      (
        await fetch(`${base}/api/v1/experiments/choices/early-access`, {
          method: 'PUT',
          headers: otherHeaders,
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
      200,
    );
    assert.deepEqual(
      await (
        await fetch(`${base}/api/v1/experiments/choices`, {
          headers: otherHeaders,
        })
      ).json(),
      {
        choices: { ...migrateExtractedLabsChoices({}), 'early-access': false },
      },
    );
    getScenario(key).cloud.experiments.putStatus = 503;
    assert.equal(
      (
        await fetch(`${base}/api/v1/experiments/choices/early-access`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
      503,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CAN-4266: shared agent search reaches beyond the first 25 rows', async () => {
  resetAll();
  const key = 'csk_can4266_search';
  registerScenario(key, {
    cloud: {
      sharedAgents: Array.from({ length: 30 }, (_, index) => ({
        id: `agent-${index}`,
        name: `Reviewer ${index}`,
        instructionsPreview: `Instructions ${index}`,
        shareScope: 'organization',
      })),
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `Bearer ${key}` };
  try {
    const first = await (
      await fetch(`${base}/api/v1/canopy/agents?limit=25`, { headers })
    ).json();
    assert.equal(first.agents.length, 25);
    assert.equal(
      first.agents.some((agent) => agent.id === 'agent-29'),
      false,
    );
    const search = await (
      await fetch(`${base}/api/v1/canopy/agents?limit=25&q=Reviewer%2029`, {
        headers,
      })
    ).json();
    assert.deepEqual(
      search.agents.map((agent) => agent.id),
      ['agent-29'],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
