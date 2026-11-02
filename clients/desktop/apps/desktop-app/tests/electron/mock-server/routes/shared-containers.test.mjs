import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  clearScenario,
  getScenarioActivity,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import {
  handleSharedContainersRequest,
  sharedContainerPackageMetadata,
} from './shared-containers.mjs';

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handled = await handleSharedContainersRequest(request, response, url);
    if (!handled) {
      response.writeHead(404).end('not handled');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error(
          'Shared-container mock server did not bind a TCP port.',
        );
      }
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function readStreamChunk(reader, timeoutMs = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out reading inbox SSE frame')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test('lists no shared containers for a signed-in key outside the fixture', async () => {
  // Every mock account advertises `shared-containers-v1`, so a spec signed in
  // with its own key reads the sidebar's listings. They are empty rather than
  // a 401 that the sidebar would show as a load failure.
  resetAll();
  const key = 'csk_can4266_marketplace_agents';
  const { server, base } = await startServer();
  try {
    for (const path of [
      '/api/v1/shared-containers/shared-with-me',
      '/api/v1/shared-containers/shared-by-me',
      '/api/v1/shared-containers/dismissed',
    ]) {
      const response = await sharedContainerFetch(base, key, path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), {
        containers: [],
        nextCursor: null,
      });
    }
    const write = await sharedContainerFetch(
      base,
      key,
      '/api/v1/shared-containers',
      { method: 'POST', body: '{}' },
    );
    assert.equal(write.status, 401);
  } finally {
    server.close();
  }
});

test('isolates shared-container scenarios owned by concurrent Playwright workers', async () => {
  resetAll();
  const firstKey = 'csk_shared_containers_e2e_worker-1';
  const secondKey = 'csk_shared_containers_e2e_worker-2';
  registerScenario(firstKey, { sharedContainers: { members: [] } });
  registerScenario(secondKey, {});
  const { server, base } = await startServer();

  const get = (path, key) =>
    fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${key}` },
    });

  try {
    const firstMembers = await get(
      '/api/v1/shared-containers/members?q=Ada',
      firstKey,
    );
    assert.equal(firstMembers.status, 200);
    assert.deepEqual(await firstMembers.json(), { members: [] });

    const secondMembers = await get(
      '/api/v1/shared-containers/members?q=Ada',
      secondKey,
    );
    assert.equal(secondMembers.status, 200);
    assert.equal((await secondMembers.json()).members[0]?.name, 'Ada Lovelace');

    clearScenario(firstKey);
    const secondListing = await get(
      '/api/v1/shared-containers/shared-by-me?organizationId=77777777-7777-4777-8777-777777777777',
      secondKey,
    );
    assert.equal(secondListing.status, 200);
    assert.deepEqual(await secondListing.json(), {
      containers: [],
      nextCursor: null,
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('dismisses a recipient share and removes it from later listings', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-dismiss';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const containerId = '55555555-5555-4555-8555-555555555552';
  registerScenario(key, {
    sharedContainersState: {
      containers: [{ id: containerId, organizationId }],
      grants: [{ containerId }],
      stagedRevisions: [],
      nextContainer: 1,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `Bearer ${key}` };

  try {
    const dismissed = await fetch(
      `${base}/api/v1/shared-containers/${containerId}/dismiss?organizationId=${organizationId}`,
      { method: 'DELETE', headers },
    );
    assert.equal(dismissed.status, 204);

    const listing = await fetch(
      `${base}/api/v1/shared-containers/shared-with-me?organizationId=${organizationId}`,
      { headers },
    );
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), {
      containers: [],
      nextCursor: null,
    });
    assert.equal(getScenarioActivity(key).sharedContainersDismiss, 1);
  } finally {
    server.close();
    resetAll();
  }
});

test('keeps a dismissed share restorable and pages the dismissed listing', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-restore';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const ids = [1, 2, 3].map((n) => `55555555-5555-4555-8555-55555555556${n}`);
  const directId = '55555555-5555-4555-8555-555555555569';
  registerScenario(key, {
    sharedContainersState: {
      containers: [
        ...ids.map((id) => ({ id, organizationId, revision: 1 })),
        { id: directId, access: 'direct', revision: 1 },
      ],
      grants: [{ id: 'grant-1', containerId: ids[0] }],
      stagedRevisions: [],
      nextContainer: 1,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();
  const organization = `organizationId=${organizationId}`;
  const call = (path, init) => sharedContainerFetch(base, key, path, init);
  const listed = async (path) => (await (await call(path)).json()).containers;

  try {
    for (const id of [...ids, directId]) {
      const dismissed = await call(
        `/api/v1/shared-containers/${id}/dismiss${id === directId ? '' : `?${organization}`}`,
        { method: 'DELETE' },
      );
      assert.equal(dismissed.status, 204);
    }
    assert.deepEqual(
      await listed(`/api/v1/shared-containers/shared-with-me?${organization}`),
      [],
    );

    // Newest removal first, scoped like shared-with-me, paged by limit/cursor.
    const firstPage = await (
      await call(`/api/v1/shared-containers/dismissed?${organization}&limit=2`)
    ).json();
    assert.deepEqual(
      firstPage.containers.map((container) => container.id),
      [ids[2], ids[1]],
    );
    assert.equal(typeof firstPage.containers[0].dismissedAt, 'string');
    assert.equal(firstPage.containers[0].access, 'organization');
    assert.equal(typeof firstPage.nextCursor, 'string');
    const secondPage = await (
      await call(
        `/api/v1/shared-containers/dismissed?${organization}&limit=2&cursor=${firstPage.nextCursor}`,
      )
    ).json();
    assert.deepEqual(
      secondPage.containers.map((container) => container.id),
      [ids[0]],
    );
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(
      (await listed('/api/v1/shared-containers/dismissed')).map(
        (container) => container.id,
      ),
      [directId],
    );

    const wrongOrganization = await call(
      `/api/v1/shared-containers/${directId}/restore?${organization}`,
      { method: 'POST' },
    );
    assert.equal(wrongOrganization.status, 404);
    assert.equal(
      (await wrongOrganization.json()).code,
      'shared-container-dismissal-not-found',
    );

    const restored = await call(
      `/api/v1/shared-containers/${ids[0]}/restore?${organization}`,
      { method: 'POST' },
    );
    assert.equal(restored.status, 200);
    const body = await restored.json();
    assert.equal(body.container.id, ids[0]);
    assert.equal(body.container.dismissedAt, undefined);
    assert.deepEqual(
      (
        await listed(`/api/v1/shared-containers/shared-with-me?${organization}`)
      ).map((container) => container.id),
      [ids[0]],
    );
    assert.deepEqual(
      (await listed(`/api/v1/shared-containers/dismissed?${organization}`)).map(
        (container) => container.id,
      ),
      [ids[2], ids[1]],
    );
    // The grant came back with the share.
    assert.deepEqual(
      (
        await (
          await call(`/api/v1/shared-containers/${ids[0]}/recipients`)
        ).json()
      ).recipients.map((grant) => grant.id),
      ['grant-1'],
    );

    const again = await call(
      `/api/v1/shared-containers/${ids[0]}/restore?${organization}`,
      { method: 'POST' },
    );
    assert.equal(again.status, 200);
    const unknown = await call(
      '/api/v1/shared-containers/55555555-5555-4555-8555-555555555500/restore',
      { method: 'POST' },
    );
    assert.equal(unknown.status, 404);

    const activity = getScenarioActivity(key);
    assert.equal(activity.sharedContainersDismiss, 4);
    assert.equal(activity.sharedContainersListDismissed, 4);
    assert.equal(activity.sharedContainersRestore, 2);
    assert.equal(activity.sharedContainersUnexpectedMutation, undefined);
  } finally {
    server.close();
    resetAll();
  }
});

test('stops a restore once the owner revoked the removed recipient', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-restore-revoked';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const byGrant = '55555555-5555-4555-8555-555555555571';
  const byUser = '55555555-5555-4555-8555-555555555572';
  registerScenario(key, {
    sharedContainersState: {
      containers: [
        { id: byGrant, organizationId, revision: 1 },
        { id: byUser, organizationId, revision: 1 },
      ],
      grants: [{ id: 'grant-revoked', containerId: byGrant }],
      stagedRevisions: [],
      nextContainer: 1,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();
  const call = (path, init) => sharedContainerFetch(base, key, path, init);

  try {
    for (const id of [byGrant, byUser]) {
      await call(`/api/v1/shared-containers/${id}/dismiss`, {
        method: 'DELETE',
      });
    }
    // The owner still sees the removed recipient, marked as removed.
    const recipients = await (
      await call(`/api/v1/shared-containers/${byGrant}/recipients`)
    ).json();
    assert.equal(recipients.recipients.length, 1);
    assert.equal(recipients.recipients[0].id, 'grant-revoked');
    assert.equal(typeof recipients.recipients[0].dismissedAt, 'string');

    const missingGrant = await call(
      `/api/v1/shared-containers/${byGrant}/grants/unknown-grant`,
      { method: 'DELETE' },
    );
    assert.equal(missingGrant.status, 404);
    const revoked = await call(
      `/api/v1/shared-containers/${byGrant}/grants/grant-revoked`,
      { method: 'DELETE' },
    );
    assert.equal(revoked.status, 204);
    // A seeded recipient share has no grant row; the by-user revoke drops it.
    const revokedByUser = await call(
      `/api/v1/shared-containers/${byUser}/recipients/any-user`,
      { method: 'DELETE' },
    );
    assert.equal(revokedByUser.status, 204);

    for (const id of [byGrant, byUser]) {
      const restore = await call(`/api/v1/shared-containers/${id}/restore`, {
        method: 'POST',
      });
      assert.equal(restore.status, 404);
      assert.equal(
        (await restore.json()).code,
        'shared-container-dismissal-not-found',
      );
    }
    const dismissed = await (
      await call(
        `/api/v1/shared-containers/dismissed?organizationId=${organizationId}`,
      )
    ).json();
    assert.deepEqual(dismissed, { containers: [], nextCursor: null });
  } finally {
    server.close();
    resetAll();
  }
});

test('streams a detail frame when the account inbox gains a container', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-inbox-stream';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const firstContainer = {
    id: '55555555-5555-4555-8555-555555555551',
    organizationId,
    revision: 1,
  };
  const addedContainer = {
    id: '55555555-5555-4555-8555-555555555552',
    organizationId,
    revision: 3,
  };
  registerScenario(key, {
    sharedContainers: { stream: 'enabled' },
    sharedContainersState: {
      containers: [firstContainer],
      grants: [],
      stagedRevisions: [],
      nextContainer: 2,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();
  const abort = new AbortController();

  try {
    const response = await fetch(
      `${base}/api/v1/shared-containers/shared-with-me/stream`,
      {
        headers: { authorization: `Bearer ${key}` },
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.match(
      new TextDecoder().decode((await readStreamChunk(reader)).value),
      /: connected/,
    );

    registerScenario(key, {
      sharedContainers: { stream: 'enabled' },
      sharedContainersState: {
        containers: [firstContainer, addedContainer],
        grants: [],
        stagedRevisions: [],
        nextContainer: 3,
        nextGrant: 1,
        nextRevision: 1,
      },
    });

    const frame = new TextDecoder().decode(
      (await readStreamChunk(reader)).value,
    );
    assert.match(frame, /event: sharedcontainer\.detail/);
    assert.match(frame, new RegExp(addedContainer.id));
    assert.match(frame, /"revision":3/);
  } finally {
    abort.abort();
    server.close();
    resetAll();
  }
});

test('returns 404 when the account inbox stream is disabled', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-inbox-disabled';
  registerScenario(key, {
    sharedContainers: { stream: 'disabled' },
  });
  const { server, base } = await startServer();

  try {
    const response = await fetch(
      `${base}/api/v1/shared-containers/shared-with-me/stream`,
      { headers: { authorization: `Bearer ${key}` } },
    );
    assert.equal(response.status, 404);
  } finally {
    server.close();
    resetAll();
  }
});

async function sharedContainerFetch(base, key, path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

test('creates the first owner container while enabling a link without an invite', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-first-link';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  registerScenario(key, {});
  const { server, base } = await startServer();

  try {
    const created = await sharedContainerFetch(
      base,
      key,
      '/api/v1/shared-containers/link',
      {
        method: 'PUT',
        body: JSON.stringify({
          worktreeId: 'aaaa0000-0000-4000-8000-000000000099',
          organizationId,
          audience: 'ANYONE',
        }),
      },
    );
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.container.revision, 0);
    assert.equal(body.container.organizationId, organizationId);
    assert.equal(body.link.audience, 'ANYONE');
    assert.match(body.link.url, /^\/share\/view\//);

    const recipients = await (
      await sharedContainerFetch(
        base,
        key,
        `/api/v1/shared-containers/${body.container.id}/recipients?organizationId=${organizationId}`,
      )
    ).json();
    assert.deepEqual(recipients.recipients, []);
    assert.equal(getScenarioActivity(key)['sharedContainersLinkSet:ANYONE'], 1);
  } finally {
    server.close();
    resetAll();
  }
});

test('invites an email recipient into a personal container and lists it as a direct share', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-email-personal';
  registerScenario(key, {});
  const { server, base } = await startServer();

  try {
    const created = await sharedContainerFetch(
      base,
      key,
      '/api/v1/shared-containers',
      {
        method: 'POST',
        body: JSON.stringify({
          worktreeId: 'aaaa0000-0000-4000-8000-000000000001',
          recipient: { kind: 'email', email: ' Ada@Example.com ' },
          capabilities: ['VIEW'],
        }),
      },
    );
    assert.equal(created.status, 201);
    const { container, grant } = await created.json();
    assert.equal(container.organizationId, undefined);
    assert.equal(container.access, 'direct');
    assert.deepEqual(container.owner, {
      userId: '99999999-9999-4999-8999-999999999999',
      name: 'Mock Owner',
    });
    assert.deepEqual(grant.recipient, {
      kind: 'email',
      email: 'ada@example.com',
      status: 'invited',
    });
    assert.equal(getScenarioActivity(key).sharedContainersCreateEmail, 1);

    const byMe = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/shared-by-me',
      )
    ).json();
    assert.deepEqual(
      byMe.containers.map((candidate) => candidate.id),
      [container.id],
    );
    const direct = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/shared-with-me',
      )
    ).json();
    assert.deepEqual(
      direct.containers.map((candidate) => candidate.id),
      [container.id],
    );
    const organizationListing = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/shared-with-me?organizationId=77777777-7777-4777-8777-777777777777',
      )
    ).json();
    assert.deepEqual(organizationListing.containers, []);

    // A member cannot be granted into a personal container.
    const member = await sharedContainerFetch(
      base,
      key,
      '/api/v1/shared-containers',
      {
        method: 'POST',
        body: JSON.stringify({
          worktreeId: 'aaaa0000-0000-4000-8000-000000000001',
          recipient: {
            kind: 'member',
            userId: '11111111-1111-4111-8111-111111111111',
          },
          capabilities: ['VIEW'],
        }),
      },
    );
    assert.equal(member.status, 400);
  } finally {
    server.close();
    resetAll();
  }
});

test('refuses an email recipient for an organization container until the organization allows it', async () => {
  resetAll();
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const offKey = 'csk_shared_containers_e2e_worker-email-off';
  const onKey = 'csk_shared_containers_e2e_worker-email-on';
  registerScenario(offKey, {});
  registerScenario(onKey, {
    sharedContainers: { allowExternalContainerSharing: true },
  });
  const { server, base } = await startServer();
  const body = JSON.stringify({
    organizationId,
    worktreeId: 'aaaa0000-0000-4000-8000-000000000002',
    recipient: { kind: 'email', email: 'grace@example.com' },
    capabilities: ['VIEW'],
  });

  try {
    const refused = await sharedContainerFetch(
      base,
      offKey,
      '/api/v1/shared-containers',
      { method: 'POST', body },
    );
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, 'external-sharing-disabled');

    const allowed = await sharedContainerFetch(
      base,
      onKey,
      '/api/v1/shared-containers',
      { method: 'POST', body },
    );
    assert.equal(allowed.status, 201);
    const { container, grant } = await allowed.json();
    assert.equal(container.organizationId, organizationId);
    assert.equal(container.organizationName, 'Shared Containers E2E');
    assert.equal(container.access, 'organization');
    assert.equal(grant.recipient.kind, 'email');
  } finally {
    server.close();
    resetAll();
  }
});

test('accepts the legacy member alias and returns a discriminated member recipient', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-legacy-member';
  registerScenario(key, {});
  const { server, base } = await startServer();

  try {
    const created = await sharedContainerFetch(
      base,
      key,
      '/api/v1/shared-containers',
      {
        method: 'POST',
        body: JSON.stringify({
          organizationId: '77777777-7777-4777-8777-777777777777',
          worktreeId: 'aaaa0000-0000-4000-8000-000000000003',
          recipientUserId: '22222222-2222-4222-8222-222222222222',
          capabilities: ['VIEW'],
        }),
      },
    );
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).grant.recipient, {
      kind: 'member',
      userId: '22222222-2222-4222-8222-222222222222',
      name: 'Grace Hopper',
    });
  } finally {
    server.close();
    resetAll();
  }
});

test('narrows the member search to one team', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-team';
  registerScenario(key, {});
  const { server, base } = await startServer();

  try {
    const all = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/members?organizationId=77777777-7777-4777-8777-777777777777',
      )
    ).json();
    assert.deepEqual(
      all.members.map((member) => member.name),
      ['Ada Lovelace', 'Grace Hopper'],
    );
    assert.equal(all.members[0].teamIds, undefined);

    const team = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/members?organizationId=77777777-7777-4777-8777-777777777777&teamId=88888888-8888-4888-8888-888888888888',
      )
    ).json();
    assert.deepEqual(
      team.members.map((member) => member.name),
      ['Ada Lovelace'],
    );
  } finally {
    server.close();
    resetAll();
  }
});

test('revokes a grant or pending email invite by grant id', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-revoke-grant';
  registerScenario(key, {});
  const { server, base } = await startServer();

  try {
    const created = await (
      await sharedContainerFetch(base, key, '/api/v1/shared-containers', {
        method: 'POST',
        body: JSON.stringify({
          worktreeId: 'aaaa0000-0000-4000-8000-000000000004',
          recipient: { kind: 'email', email: 'ada@example.com' },
          capabilities: ['VIEW'],
        }),
      })
    ).json();
    const containerId = created.container.id;
    const grantId = created.grant.id;

    const wrongOrganization = await sharedContainerFetch(
      base,
      key,
      `/api/v1/shared-containers/${containerId}/grants/${grantId}?organizationId=77777777-7777-4777-8777-777777777777`,
      { method: 'DELETE' },
    );
    assert.equal(wrongOrganization.status, 404);

    const revoked = await sharedContainerFetch(
      base,
      key,
      `/api/v1/shared-containers/${containerId}/grants/${grantId}`,
      { method: 'DELETE' },
    );
    assert.equal(revoked.status, 204);
    const recipients = await (
      await sharedContainerFetch(
        base,
        key,
        `/api/v1/shared-containers/${containerId}/recipients`,
      )
    ).json();
    assert.deepEqual(recipients.recipients, []);

    const missing = await sharedContainerFetch(
      base,
      key,
      `/api/v1/shared-containers/${containerId}/grants/${grantId}`,
      { method: 'DELETE' },
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (await missing.json()).code,
      'shared-container-grant-not-found',
    );
    assert.equal(getScenarioActivity(key).sharedContainersRevoke, 1);
  } finally {
    server.close();
    resetAll();
  }
});

test('fills the owner and access on seeded organization containers', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-seeded-ref';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  registerScenario(key, {
    sharedContainersState: {
      containers: [
        { id: 'container-org', organizationId, ownerUserId: 'owner-1' },
        { id: 'container-direct', organizationId, access: 'direct' },
      ],
      grants: [],
      stagedRevisions: [],
      nextContainer: 1,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();

  try {
    const organizationListing = await (
      await sharedContainerFetch(
        base,
        key,
        `/api/v1/shared-containers/shared-with-me?organizationId=${organizationId}`,
      )
    ).json();
    assert.deepEqual(organizationListing.containers, [
      {
        id: 'container-org',
        organizationId,
        ownerUserId: 'owner-1',
        owner: { userId: 'owner-1', name: 'Mock Owner' },
        organizationName: 'Shared Containers E2E',
        access: 'organization',
      },
    ]);
    const directListing = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/shared-with-me',
      )
    ).json();
    assert.deepEqual(
      directListing.containers.map((container) => [
        container.id,
        container.access,
      ]),
      [['container-direct', 'direct']],
    );
  } finally {
    server.close();
    resetAll();
  }
});

test('names a seeded owner from the roster instead of the mock owner', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-seeded-owner-name';
  const organizationId = '77777777-7777-4777-8777-777777777777';
  const adaUserId = '11111111-1111-4111-8111-111111111111';
  registerScenario(key, {
    sharedContainersState: {
      containers: [
        { id: 'container-ada', organizationId, ownerUserId: adaUserId },
        {
          id: 'container-explicit',
          organizationId,
          ownerUserId: adaUserId,
          owner: { userId: adaUserId, name: 'Ada (explicit)' },
        },
        {
          id: 'container-unlisted',
          organizationId,
          ownerUserId: 'owner-not-on-roster',
        },
      ],
      grants: [],
      stagedRevisions: [],
      nextContainer: 1,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();

  try {
    const listing = await (
      await sharedContainerFetch(
        base,
        key,
        `/api/v1/shared-containers/shared-with-me?organizationId=${organizationId}`,
      )
    ).json();
    assert.deepEqual(
      listing.containers.map((container) => [container.id, container.owner]),
      [
        ['container-ada', { userId: adaUserId, name: 'Ada Lovelace' }],
        ['container-explicit', { userId: adaUserId, name: 'Ada (explicit)' }],
        [
          'container-unlisted',
          { userId: 'owner-not-on-roster', name: 'Mock Owner' },
        ],
      ],
    );
    const latest = await (
      await sharedContainerFetch(
        base,
        key,
        '/api/v1/shared-containers/container-ada/revisions/latest',
      )
    ).json();
    assert.deepEqual(latest.owner, { userId: adaUserId, name: 'Ada Lovelace' });
  } finally {
    server.close();
    resetAll();
  }
});

test('models capability links: set, narrow, reset, claim, and turn off', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e';
  const containerId = '55555555-5555-4555-8555-555555555551';
  registerScenario(key, {
    sharedContainersState: {
      containers: [
        {
          id: containerId,
          organizationId: '77777777-7777-4777-8777-777777777777',
          ownerUserId: '99999999-9999-4999-8999-999999999999',
          worktreeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          containerType: 'CODE_WORKTREE',
          title: 'Link feature branch',
          revision: 1,
          createdAt: '',
          updatedAt: '',
          capabilities: ['VIEW'],
          linkOnly: true,
        },
      ],
      grants: [],
      stagedRevisions: [],
      nextContainer: 2,
      nextGrant: 1,
      nextRevision: 1,
    },
  });
  const { server, base } = await startServer();
  const call = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
    });

  try {
    const initial = await call(`/api/v1/shared-containers/${containerId}/link`);
    assert.equal(initial.status, 200);
    assert.equal(await initial.json(), null);

    const set = await call(`/api/v1/shared-containers/${containerId}/link`, {
      method: 'PUT',
      body: JSON.stringify({ audience: 'ANYONE' }),
    });
    const link = await set.json();
    assert.equal(link.audience, 'ANYONE');
    assert.match(
      link.url,
      /^\/share\/view\/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    );
    const token = link.url.split('/').pop();

    const hidden = await call(
      '/api/v1/shared-containers/shared-with-me?organizationId=77777777-7777-4777-8777-777777777777',
    );
    assert.deepEqual((await hidden.json()).containers, []);

    const landing = await call(`/api/v1/shared-container-links/${token}`);
    const summary = await landing.json();
    assert.equal(summary.state, 'ready');
    assert.equal(summary.title, 'Link feature branch');
    assert.equal(summary.alreadyHasAccess, false);

    const claim = await call(`/api/v1/shared-container-links/${token}/claim`, {
      method: 'POST',
    });
    assert.equal((await claim.json()).id, containerId);
    const listed = await call(
      '/api/v1/shared-containers/shared-with-me?organizationId=77777777-7777-4777-8777-777777777777',
    );
    assert.equal((await listed.json()).containers[0]?.id, containerId);

    const reset = await call(
      `/api/v1/shared-containers/${containerId}/link/reset`,
      { method: 'POST' },
    );
    const rotated = await reset.json();
    assert.notEqual(rotated.url, link.url);
    const stale = await call(`/api/v1/shared-container-links/${token}`);
    assert.equal(stale.status, 404);

    const off = await call(`/api/v1/shared-containers/${containerId}/link`, {
      method: 'DELETE',
    });
    assert.equal(off.status, 204);
    const after = await call(`/api/v1/shared-containers/${containerId}/link`);
    assert.equal(await after.json(), null);

    const activity = getScenarioActivity(key);
    assert.equal(activity['sharedContainersLinkSet:ANYONE'], 1);
    assert.equal(activity.sharedContainersLinkClaim, 1);
    assert.equal(activity.sharedContainersLinkReset, 1);
    assert.equal(activity.sharedContainersLinkRemoved, 1);
  } finally {
    server.close();
    clearScenario(key);
  }
});

test('pins capability packages across stage replay, parent retirement and commit', async () => {
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-packages';
  const digest = `pp:v1:${'A'.repeat(43)}`;
  const hash = 'a'.repeat(64);
  const upload = {
    state: 'COMMITTED',
    expiresAt: '2099-01-01T00:00:00Z',
    digest,
    manifest: {
      version: 1,
      pipelineContentHash: hash,
      totalFiles: 1,
      totalBytes: 2,
      resources: [
        {
          id: 'agent',
          kind: 'agent_definition',
          displayName: 'Reviewer',
          sourceLabel: 'private',
          sourceVisibility: 'private',
          dependencyResourceIds: [],
          invocationKeys: [],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'plugin_fragment',
              rootName: 'agent',
              entries: [
                { path: 'agent.json', sha256: hash, size: 2, mode: 'read' },
              ],
            },
          ],
        },
      ],
      bindings: [{ target: 'subject', resourceIds: ['agent'] }],
      environmentRequirements: [],
    },
    blobs: {
      [hash]: Buffer.from('{}').toString('base64'),
      ['b'.repeat(64)]: Buffer.from('secret').toString('base64'),
    },
  };
  const state = {
    containers: [
      {
        id: 'container',
        title: 'Share',
        revision: 0,
        owner: {
          userId: '99999999-9999-4999-8999-999999999999',
          name: 'Owner',
        },
      },
    ],
    grants: [],
    stagedRevisions: [],
    revisions: [],
    nextRevision: 1,
  };
  registerScenario(key, {
    sharedContainers: { packageUploads: { upload } },
    sharedContainersState: state,
  });
  const { server, base } = await startServer();
  const call = (path, body, version = '5') =>
    fetch(`${base}/api/v1/shared-containers/container/revisions/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Pipeline-Package-Version': version,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const stageBody = {
    idempotencyKey: 'stage',
    title: 'Share',
    sourceDeviceId: 'device',
    schemaVersion: 5,
    artifacts: [],
    capabilityPackage: { version: 1, digest },
    committedPackageUploadId: 'upload',
  };
  try {
    assert.equal(
      (await call('stage', { ...stageBody, carryParentPackage: true })).status,
      400,
    );
    const staged = await (await call('stage', stageBody)).json();
    upload.expiresAt = '2000-01-01T00:00:00Z';
    assert.deepEqual(await (await call('stage', stageBody)).json(), staged);
    assert.equal(
      (
        await (
          await call('stage', { ...stageBody, idempotencyKey: 'expired' })
        ).json()
      ).code,
      'shared_container_package_upload_expired',
    );
    assert.equal(
      (
        await call('stage', {
          ...stageBody,
          capabilityPackage: undefined,
          committedPackageUploadId: undefined,
        })
      ).status,
      409,
    );
    const committed = await (
      await call('commit', { stagingSessionId: 'stage' })
    ).json();
    assert.equal(committed.revision.package.digest, digest);
    assert.equal(committed.revision.package.counts.agents, 1);
    assert.deepEqual(
      await (await call('commit', { stagingSessionId: 'stage' })).json(),
      committed,
    );
    assert.equal(
      (await (await call(staged.revisionId, undefined, '4')).json()).revision
        .package,
      undefined,
    );
    const read = `${staged.revisionId}/package?expectedPackageDigest=${encodeURIComponent(digest)}`;
    const old = await call(read, undefined, '4');
    assert.equal(old.status, 426);
    assert.equal(old.headers.get('Cache-Control'), 'no-store');
    assert.equal((await call(read)).status, 200);
    assert.equal(
      (
        await call(
          `${staged.revisionId}/package/blobs/${'b'.repeat(64)}?expectedPackageDigest=${encodeURIComponent(digest)}`,
        )
      ).status,
      404,
    );
    const blob = await call(
      `${staged.revisionId}/package/blobs/${hash}?expectedPackageDigest=${encodeURIComponent(digest)}`,
    );
    assert.equal(await blob.text(), '{}');
    const carry = {
      ...stageBody,
      idempotencyKey: 'carry',
      capabilityPackage: undefined,
      committedPackageUploadId: undefined,
      carryParentPackage: true,
      parentRevisionId: staged.revisionId,
    };
    assert.equal((await call('stage', carry)).status, 200);
    state.revisions[0].retired = true;
    state.revisions[0].packageDownload = undefined;
    assert.equal((await call('stage', carry)).status, 200);
    assert.equal((await call(read)).status, 404);
    const carried = await (
      await call('commit', { stagingSessionId: 'carry' })
    ).json();
    assert.equal(carried.revision.package.digest, digest);
    assert.equal(
      state.stagedRevisions.every(
        (entry) => entry.packageDownload === undefined,
      ),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves an organization share package to members and only the pinned digest', async () => {
  // CAN-4655 fork flow: a recipient of an organization share holds no grant,
  // yet installs the package its fork disclosed. Direct shares still need one.
  resetAll();
  const key = 'csk_shared_containers_e2e_worker-org-package';
  const digest = `pp:v1:${'B'.repeat(43)}`;
  const hash = 'c'.repeat(64);
  const packageDownload = {
    digest,
    manifest: {
      version: 1,
      pipelineContentHash: hash,
      totalFiles: 1,
      totalBytes: 2,
      resources: [
        {
          id: 'skill',
          kind: 'standalone_skill',
          displayName: 'helper',
          sourceLabel: 'local',
          sourceVisibility: 'local',
          dependencyResourceIds: [],
          invocationKeys: ['/helper'],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'standalone_skill',
              rootName: 'helper',
              entries: [
                { path: 'run.sh', sha256: hash, size: 2, mode: 'execute' },
              ],
            },
          ],
        },
      ],
      bindings: [{ target: 'subject', resourceIds: ['skill'] }],
      environmentRequirements: [],
    },
    blobs: { [hash]: Buffer.from('{}').toString('base64') },
  };
  const container = (id, access) => ({
    id,
    organizationId: '77777777-7777-4777-8777-777777777777',
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    title: 'Share',
    revision: 1,
    ...(access ? { access } : {}),
  });
  registerScenario(key, {
    sharedContainersState: {
      containers: [container('org-share'), container('direct-share', 'direct')],
      grants: [],
      stagedRevisions: [],
      revisions: [
        { containerId: 'org-share', revision: { id: 'r1' }, packageDownload },
        {
          containerId: 'direct-share',
          revision: { id: 'r1' },
          packageDownload,
        },
      ],
    },
  });
  const { server, base } = await startServer();
  const read = (containerId, suffix = '', expected = digest) =>
    fetch(
      `${base}/api/v1/shared-containers/${containerId}/revisions/r1/package${suffix}?expectedPackageDigest=${encodeURIComponent(expected)}&organizationId=77777777-7777-4777-8777-777777777777`,
      {
        headers: {
          authorization: `Bearer ${key}`,
          'X-Pipeline-Package-Version': '5',
        },
      },
    );
  try {
    const manifest = await read('org-share');
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).digest, digest);
    const blob = await read('org-share', `/blobs/${hash}`);
    assert.equal(await blob.text(), '{}');
    assert.equal(
      (await read('org-share', '', `pp:v1:${'C'.repeat(43)}`)).status,
      409,
    );
    assert.equal((await read('direct-share')).status, 404);
    assert.deepEqual(sharedContainerPackageMetadata(packageDownload), {
      digest,
      counts: { skills: 1, pipelines: 0, agents: 0, automations: 0, hooks: 0 },
      executableFiles: ['helper/run.sh'],
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearScenario(key);
  }
});

test('summarizes only what a copy installs, leaving plugin members out', () => {
  const kinds = [
    'standalone_skill',
    'plugin_skill',
    'plugin_command',
    'plugin_agent',
    'agent_definition',
    'child_pipeline',
    'pipeline_definition',
    'automation_definition',
    'hook_definition',
    'pipeline_action',
  ];
  const digest = `pp:v1:${'A'.repeat(43)}`;
  const resources = kinds.map((kind) => ({
    id: kind,
    kind,
    displayName: kind,
    sourceLabel: 'source',
    sourceVisibility: 'private',
    invocationKeys: [],
    dependencyResourceIds: [],
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'plugin_fragment',
        rootName: kind,
        entries: [
          { path: 'file', mode: 'execute', sha256: 'a'.repeat(64), size: 1 },
        ],
      },
    ],
  }));
  assert.deepEqual(
    sharedContainerPackageMetadata({
      digest,
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources,
        bindings: [],
        environmentRequirements: [],
        totalFiles: resources.length,
        totalBytes: resources.length,
      },
    }),
    {
      digest,
      counts: { skills: 1, pipelines: 1, agents: 1, automations: 1, hooks: 1 },
      executableFiles: [
        'agent_definition/file',
        'automation_definition/file',
        'child_pipeline/file',
        'hook_definition/file',
        'pipeline_action/file',
        'pipeline_definition/file',
        'standalone_skill/file',
      ],
    },
  );
});
