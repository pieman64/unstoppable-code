// CAN-4263 — owners manage their shared Marketplace items.
//
// An owner (the share's `canDelete` verdict) sees Unshare first among the
// detail's secondary actions for a shared skill, collection, agent and
// plugin, and other members do not. Cancel sends nothing; confirming sends
// one DELETE to the kind's route, toasts, returns to browse and drops the
// row. A refused delete keeps the dialog open with the reason and retries.
// "Shared by me" on every Marketplace tab lists only the viewer's own shares,
// alongside the Browse section. A collection owner's Edit saves
// through PUT, survives reopening, and keeps the edits when a save fails.
//
// Deterministic: main's `fetch` serves the four shared lists, their details,
// DELETE and the collection PUT from in-memory state; everything else goes
// to the shared mock server. No network, no live agents.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

const VIEWER = { id: 'account-e2e', name: 'Portal E2E' };
const OTHER = { id: 'account-other-can4263', name: 'Other Member' };
const NOW = '2026-10-01T00:00:00.000Z';
const ORGANIZATION = {
  type: 'organization',
  id: 'org-can4263',
  name: 'Acme Robotics',
};

function skill(id, name, author) {
  return {
    id,
    name,
    description: `${name} description.`,
    contentHash: `sha256:${id}`,
    shareScope: 'organization',
    owner: ORGANIZATION,
    createdBy: author,
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: author === VIEWER,
    canDelete: author === VIEWER,
    publicShare: null,
    rawSkill: `---\nname: ${name}\ndescription: ${name} description.\n---\n\n# ${name}\n`,
  };
}

function collection(id, name, author) {
  const document = {
    version: 1,
    name,
    description: `${name} description.`,
    items: [],
  };
  return {
    id,
    name,
    description: document.description,
    contentHash: `sha256:${id}:1`,
    itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
    shareScope: 'organization',
    owner: ORGANIZATION,
    createdBy: author,
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: author === VIEWER,
    canDelete: author === VIEWER,
    rawCollection: JSON.stringify(document),
    collection: document,
    customSkills: [],
  };
}

function agent(id, name, author) {
  const modelId = `agent_model_${id.replaceAll('-', '_')}`;
  return {
    id,
    name,
    modelId,
    baseModel: 'sonnet',
    instructionsPreview: `${name} instructions.`,
    contentHash: 'c'.repeat(64),
    shareScope: 'organization',
    owner: ORGANIZATION,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: author,
    canUpdate: author === VIEWER,
    canDelete: author === VIEWER,
    publicShare: null,
    agent: {
      version: 1,
      id: modelId,
      name,
      baseModel: 'sonnet',
      instructions: `${name} instructions.`,
      plugins: [],
    },
  };
}

function plugin(externalId, name, pluginName, author) {
  return {
    externalId,
    refKey: `plugin:github:acme/tools:${pluginName}`,
    ref: {
      type: 'plugin',
      marketplace: { type: 'github', repo: 'acme/tools' },
      plugin_name: pluginName,
    },
    name,
    description: `${name} description.`,
    marketplaceOrigin: 'github:acme/tools',
    owner: ORGANIZATION,
    shareScope: 'organization',
    createdBy: author,
    createdAt: NOW,
    updatedAt: NOW,
    canUpdate: author === VIEWER,
    canDelete: author === VIEWER,
    publicShare: null,
  };
}

const OWNED = {
  skill: skill('can4263-owned-skill', 'Release Checklist Skill', VIEWER),
  collection: collection(
    'can4263-owned-collection',
    'Release Kit Collection',
    VIEWER,
  ),
  agent: agent('can4263-owned-agent', 'Release Captain Agent', VIEWER),
  plugin: plugin(
    'can4263-owned-plugin',
    'Release Notes Plugin',
    'release-notes',
    VIEWER,
  ),
};

const FOREIGN = {
  skill: skill('can4263-other-skill', 'Incident Triage Skill', OTHER),
  collection: collection(
    'can4263-other-collection',
    'Incident Kit Collection',
    OTHER,
  ),
  agent: agent('can4263-other-agent', 'Incident Scribe Agent', OTHER),
  plugin: plugin(
    'can4263-other-plugin',
    'Incident Pager Plugin',
    'incident-pager',
    OTHER,
  ),
};

/** The account share's own identifier: plugins use their `externalId`. */
function shareId(kind, row) {
  return kind === 'plugin' ? row.externalId : row.id;
}

function entryTestId(kind, row) {
  return `plugins-entry-${kind}:shared:${shareId(kind, row)}`;
}

function deletePath(kind, row) {
  const collectionName = {
    skill: 'skills',
    collection: 'collections',
    agent: 'agents',
    plugin: 'plugins',
  }[kind];
  return `/api/v1/canopy/${collectionName}/${shareId(kind, row)}`;
}

/**
 * Serves the four shared kinds from main-process state. Lists honor
 * `createdBy=me` and `q`; DELETE and the collection PUT mutate the state, and
 * a queued failure answers the next matching request instead.
 */
async function installSharedMarketplaceMock(electronApp, rows, viewerId) {
  await electronApp.evaluate(
    (_electron, { initialRows, viewer }) => {
      const originalFetch = globalThis.fetch;
      const savedAt = Date.parse('2026-10-01T00:00:00.000Z');
      const state = {
        rows: structuredClone(initialRows),
        requests: [],
        failures: {},
        deleted: [],
      };
      globalThis.__can4263 = state;
      const json = (status, body) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const listKeys = {
        skills: 'skill',
        collections: 'collection',
        agents: 'agent',
        plugins: 'plugin',
      };
      const idOf = (kind, row) => (kind === 'plugin' ? row.externalId : row.id);
      globalThis.fetch = async (input, init) => {
        const rawUrl =
          typeof input === 'string' || input instanceof URL
            ? String(input)
            : input.url;
        const url = new URL(rawUrl);
        const method = (
          init?.method ??
          (typeof input === 'object' && 'method' in input
            ? input.method
            : 'GET')
        ).toUpperCase();
        const match = url.pathname.match(
          /\/api\/v1\/(?:canopy|desktop-app)\/(skills|collections|agents|plugins|pipelines|automations|workspace-template-shares)(?:\/([^/]+))?$/,
        );
        if (!match) return originalFetch(input, init);
        const [, resource, id] = match;
        // The API namespace is brand-specific; key failures by the canonical route.
        const routePath = `/api/v1/canopy/${resource}${id ? `/${id}` : ''}`;
        const ownedOnly = url.searchParams.get('createdBy') === 'me';
        const kind = listKeys[resource];
        if (!kind) {
          // Isolate these four kinds in catalog and owned reads; another
          // spec's published fixture must not join this owned section.
          if (method === 'GET' && !id) {
            state.requests.push({ method, resource, ownedOnly });
            if (resource === 'automations')
              return json(200, { automations: [], nextCursor: null });
            if (resource === 'workspace-template-shares')
              return json(200, { shares: [], nextCursor: null });
            return json(200, { data: [], nextCursor: null });
          }
          return originalFetch(input, init);
        }
        const request = {
          method,
          resource,
          id: id ? decodeURIComponent(id) : null,
          ownedOnly,
          body: typeof init?.body === 'string' ? init.body : null,
        };
        state.requests.push(request);
        const failure = state.failures[`${method} ${routePath}`]?.shift();
        if (failure) return json(failure.status, failure.body);
        const rowsOfKind = state.rows[kind];
        if (method === 'GET' && !id) {
          const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          const listed = rowsOfKind.filter(
            (row) =>
              (!ownedOnly || row.createdBy.id === viewer) &&
              (!q || row.name.toLowerCase().includes(q)),
          );
          if (kind === 'plugin') return json(200, { data: listed });
          return json(200, { [resource]: listed, nextCursor: null });
        }
        const index = rowsOfKind.findIndex(
          (row) => idOf(kind, row) === request.id,
        );
        if (index < 0) {
          // Unshared ids are gone; other ids (curated catalogs, public
          // links) belong to the shared mock server.
          return state.deleted.includes(`${kind}:${request.id}`)
            ? json(404, { error: 'Not found' })
            : originalFetch(input, init);
        }
        if (method === 'GET') return json(200, rowsOfKind[index]);
        if (method === 'DELETE') {
          rowsOfKind.splice(index, 1);
          state.deleted.push(`${kind}:${request.id}`);
          return new Response(null, { status: 204 });
        }
        if (method === 'PUT' && kind === 'collection') {
          const body = JSON.parse(String(init.body));
          const document = JSON.parse(body.rawCollection);
          const current = rowsOfKind[index];
          const revision =
            Number(current.contentHash.split(':').pop() ?? '1') + 1;
          const updated = {
            ...current,
            name: document.name,
            description: document.description ?? '',
            rawCollection: body.rawCollection,
            collection: document,
            contentHash: `sha256:${current.id}:${revision}`,
            updatedAt: new Date(savedAt + revision * 1000).toISOString(),
          };
          rowsOfKind[index] = updated;
          return json(200, updated);
        }
        return originalFetch(input, init);
      };
    },
    { initialRows: rows, viewer: viewerId },
  );
}

async function readMockRequests(electronApp) {
  return electronApp.evaluate(() => globalThis.__can4263.requests);
}

async function queueFailure(electronApp, method, pathname, failure) {
  await electronApp.evaluate(
    (_electron, { key, next }) => {
      const queue = (globalThis.__can4263.failures[key] ??= []);
      queue.push(next);
    },
    { key: `${method} ${pathname}`, next: failure },
  );
}

async function launchOwnerSession(apiKey) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4263-unshare-'));
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  await window.setViewportSize({ width: 1400, height: 900 });
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await installSharedMarketplaceMock(
    electronApp,
    {
      skill: [OWNED.skill, FOREIGN.skill],
      collection: [OWNED.collection, FOREIGN.collection],
      agent: [OWNED.agent, FOREIGN.agent],
      plugin: [OWNED.plugin, FOREIGN.plugin],
    },
    VIEWER.id,
  );
  return { electronApp, userDataDir, window, app };
}

const KINDS = ['skill', 'collection', 'agent', 'plugin'];

async function openTab(window, tab) {
  await window.getByTestId(`plugins-type-tab-${tab}`).click();
  await expect(window.getByTestId(`plugins-type-tab-${tab}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

async function openEntry(window, kind, row) {
  await openTab(window, kind);
  const entry = window.getByTestId(entryTestId(kind, row));
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  await expect(
    window.getByTestId('plugins-entry-detail-breadcrumb-root'),
  ).toBeVisible();
}

async function backToBrowse(window) {
  await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
  await expect(window.getByTestId('plugins-search')).toBeVisible();
}

/**
 * Shared agents, plugins (CAN-4266) and skills (CAN-4261) carry Unshare last
 * in the header's ⋯ menu; collections keep it leading the action bar.
 */
const IN_MORE_MENU = new Set(['agent', 'plugin', 'skill']);

/** Opens the Unshare confirmation for a detail of `kind`. */
async function startUnshare(window, kind) {
  if (IN_MORE_MENU.has(kind)) {
    await window.getByTestId('plugins-entry-detail-more').click();
  }
  await window.getByTestId('marketplace-unshare').click();
}

/**
 * The owner's Unshare where `kind` keeps it. Returns the row of page actions
 * that holds it: the header's actions for a ⋯ kind, the action bar otherwise.
 */
async function expectUnshareLeads(window, kind) {
  if (IN_MORE_MENU.has(kind)) {
    const actions = window.getByTestId('plugins-entry-detail-header-actions');
    const more = window.getByTestId('plugins-entry-detail-more');
    await expect(more).toBeVisible({ timeout: 20_000 });
    // ⋯ leads the header's actions; the primary stays last.
    await expect(actions.locator('button').first()).toHaveAttribute(
      'data-testid',
      'plugins-entry-detail-more',
    );
    await more.click();
    const menu = window.getByTestId('plugins-entry-detail-menu');
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items.last()).toHaveAttribute(
      'data-testid',
      'marketplace-unshare',
    );
    await expect(items.last()).toHaveText('Unshare');
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    return actions;
  }
  return expectUnshareInBar(window);
}

/** The detail action bar holding Unshare; Unshare is its first button. */
async function expectUnshareInBar(window) {
  const unshare = window.getByTestId('marketplace-unshare');
  await expect(unshare).toBeVisible({ timeout: 20_000 });
  await expect(unshare).toHaveText('Unshare');
  const bar = window
    .getByTestId('detail-action-bar')
    .filter({ has: unshare })
    .first();
  await expect(bar.locator('button').first()).toHaveAttribute(
    'data-testid',
    'marketplace-unshare',
  );
  return bar;
}

/**
 * Every action in the detail's bar is fully visible: below the pinned
 * titlebar (nothing paints over its top edge) and inside the page scroller.
 * The page has no Back row to center on (CAN-4261). Returns the bar's top so
 * a caller can check the row does not move when Unshare comes or goes.
 */
async function expectActionsUnclipped(window) {
  // A ⋯ kind's actions sit beside the header title, which replaced the Back
  // row (CAN-4266); the others keep the Back row's action bar.
  const headerActions = window.getByTestId(
    'plugins-entry-detail-header-actions',
  );
  const bar =
    (await headerActions.count()) > 0
      ? headerActions
      : window.getByTestId('detail-action-bar').first();
  await expect(bar).toBeVisible();
  const geometry = await bar.evaluate((barNode) => {
    const titlebar = document.querySelector(
      '[data-testid="plugins-page-titlebar"]',
    );
    const scroller = document.querySelector('[data-testid="page-plugins"]');
    const back = document.querySelector(
      '[data-testid="plugins-entry-detail-back"]',
    );
    const center = (rect) => rect.top + rect.height / 2;
    const backRect = back?.getBoundingClientRect() ?? null;
    return {
      barTop: barNode.getBoundingClientRect().top,
      titlebarBottom: titlebar?.getBoundingClientRect().bottom ?? 0,
      scrollerBottom: scroller?.getBoundingClientRect().bottom ?? 0,
      backCenter: backRect ? center(backRect) : null,
      buttons: [...barNode.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const top = document.elementFromPoint(x, rect.top + 1);
        const bottom = document.elementFromPoint(x, rect.bottom - 1);
        return {
          label: button.textContent?.trim() ?? '',
          top: rect.top,
          bottom: rect.bottom,
          center: center(rect),
          topHit: top !== null && button.contains(top),
          bottomHit: bottom !== null && button.contains(bottom),
        };
      }),
    };
  });
  expect(geometry.buttons.length).toBeGreaterThan(0);
  // CAN-4261: a detail page shows no Back; its breadcrumb leads out.
  expect(geometry.backCenter).toBeNull();
  for (const button of geometry.buttons) {
    expect(button.top, `${button.label} top`).toBeGreaterThanOrEqual(
      geometry.titlebarBottom,
    );
    expect(button.bottom, `${button.label} bottom`).toBeLessThanOrEqual(
      geometry.scrollerBottom,
    );
    expect(button.topHit, `${button.label} top edge visible`).toBe(true);
    expect(button.bottomHit, `${button.label} bottom edge visible`).toBe(true);
  }
  return geometry.barTop;
}

async function deleteRequests(electronApp) {
  return (await readMockRequests(electronApp)).filter(
    (request) => request.method === 'DELETE',
  );
}

test.describe('CAN-4263 Marketplace Unshare', () => {
  test('owners see Unshare first on all four kinds; other members do not', async () => {
    test.setTimeout(240_000);
    const session = await launchOwnerSession('csk_can4263_visibility');
    const { electronApp, userDataDir, window, app } = session;
    try {
      await app.openPluginsPage();
      for (const kind of KINDS) {
        await openEntry(window, kind, OWNED[kind]);
        const bar = await expectUnshareLeads(window, kind);
        // The owner's other actions stay mounted beside it.
        if (kind === 'skill' || kind === 'collection') {
          await expect(
            bar.getByRole('button', { name: 'Edit', exact: true }),
          ).toBeVisible();
        }
        if (kind === 'collection') {
          await expect(
            window.getByTestId('shared-collection-detail-add'),
          ).toBeVisible();
        }
        if (kind === 'agent') {
          await expect(
            window.getByTestId('shared-agent-detail-add'),
          ).toBeVisible();
        }
        if (kind === 'plugin') {
          await expect(
            window.getByTestId('shared-plugin-detail-add'),
          ).toBeVisible();
        }
        await expect(bar.locator('button')).not.toHaveCount(1);
        const ownedBarTop = await expectActionsUnclipped(window);
        await backToBrowse(window);

        await openEntry(window, kind, FOREIGN[kind]);
        // Wait for the detail to load before asserting the absence.
        await expect(
          window.getByText(FOREIGN[kind].name, { exact: true }).first(),
        ).toBeVisible();
        await window.waitForTimeout(500);
        await expect(window.getByTestId('marketplace-unshare')).toHaveCount(0);
        // With nothing rarer to offer, no ⋯ menu either.
        await expect(
          window.getByTestId('plugins-entry-detail-more'),
        ).toHaveCount(0);
        // Without Unshare the row sits exactly where it did with it.
        expect(
          Math.abs((await expectActionsUnclipped(window)) - ownedBarTop),
        ).toBeLessThanOrEqual(1);
        await backToBrowse(window);
      }
      expect(await deleteRequests(electronApp)).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Cancel sends nothing; Unshare deletes once per kind and drops the row', async () => {
    test.setTimeout(240_000);
    const session = await launchOwnerSession('csk_can4263_confirm');
    const { electronApp, userDataDir, window, app } = session;
    try {
      await app.openPluginsPage();
      for (const kind of KINDS) {
        const row = OWNED[kind];
        await openEntry(window, kind, row);
        await expectUnshareLeads(window, kind);

        await startUnshare(window, kind);
        const dialog = window.getByTestId('marketplace-unshare-dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(`Unshare “${row.name}”?`);
        await expect(dialog).toContainText(
          `People in ${ORGANIZATION.name} will no longer find this ${kind} in Marketplace.`,
        );
        if (kind === 'collection') {
          await expect(dialog).toContainText(
            'The skills in it are not unshared.',
          );
        }
        // Cancel has focus, so a stray Enter cannot unshare.
        await expect(
          dialog.getByTestId('marketplace-unshare-cancel'),
        ).toBeFocused();
        await dialog.getByTestId('marketplace-unshare-cancel').click();
        await expect(dialog).toHaveCount(0);
        expect(await deleteRequests(electronApp)).toEqual([]);

        await startUnshare(window, kind);
        await dialog.getByTestId('marketplace-unshare-confirm').click();
        await expect(dialog).toHaveCount(0);
        await expect(
          window
            .getByTestId('toast-card')
            .filter({ hasText: `Unshared “${row.name}”` }),
        ).toBeVisible();
        // Back on the browse list it opened from, without the row.
        await expect(window.getByTestId('plugins-search')).toBeVisible();
        await expect(window.getByTestId(entryTestId(kind, row))).toHaveCount(0);
        await expect(
          window.getByTestId(entryTestId(kind, FOREIGN[kind])),
        ).toBeVisible();
        const deletes = await deleteRequests(electronApp);
        expect(deletes).toHaveLength(1);
        expect(`/api/v1/canopy/${deletes[0].resource}/${deletes[0].id}`).toBe(
          deletePath(kind, row),
        );
        await electronApp.evaluate(() => {
          globalThis.__can4263.requests = [];
        });
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a refused Unshare explains itself and can be retried', async () => {
    test.setTimeout(180_000);
    const session = await launchOwnerSession('csk_can4263_retry');
    const { electronApp, userDataDir, window, app } = session;
    try {
      // A skill that shared collections still include: the server refuses
      // with its dependents.
      await queueFailure(
        electronApp,
        'DELETE',
        deletePath('skill', OWNED.skill),
        {
          status: 409,
          body: {
            error: 'Skill is referenced by collections',
            count: 1,
            collectionIds: [OWNED.collection.id],
            collections: [
              { id: OWNED.collection.id, name: OWNED.collection.name },
            ],
          },
        },
      );
      await app.openPluginsPage();
      await openEntry(window, 'skill', OWNED.skill);
      await startUnshare(window, 'skill');
      const dialog = window.getByTestId('marketplace-unshare-dialog');
      await dialog.getByTestId('marketplace-unshare-confirm').click();
      await expect(dialog).toContainText(
        'Couldn’t unshare this skill because shared collections include it. Remove it from those collections, then try again.',
      );
      await expect(
        dialog.getByTestId('marketplace-unshare-confirm'),
      ).toBeEnabled();
      // Nothing navigated away and the share is still listed.
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-root'),
      ).toBeVisible();
      await dialog.getByTestId('marketplace-unshare-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(
        window.getByTestId(entryTestId('skill', OWNED.skill)),
      ).toHaveCount(0);
      expect(await deleteRequests(electronApp)).toHaveLength(2);

      // A server error on the plugin channel, which answers with a result
      // rather than rejecting, is still a failure and still retryable.
      await queueFailure(
        electronApp,
        'DELETE',
        deletePath('plugin', OWNED.plugin),
        { status: 500, body: { error: 'Internal error' } },
      );
      await openEntry(window, 'plugin', OWNED.plugin);
      await startUnshare(window, 'plugin');
      await dialog.getByTestId('marketplace-unshare-confirm').click();
      await expect(dialog).toContainText(
        'Couldn’t unshare this plugin. Try again.',
      );
      await expect(
        window.getByTestId('toast-card').filter({ hasText: 'Unshared' }),
      ).toHaveCount(0);
      await dialog.getByTestId('marketplace-unshare-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(
        window.getByTestId(entryTestId('plugin', OWNED.plugin)),
      ).toHaveCount(0);
      expect(
        (await deleteRequests(electronApp)).filter(
          (request) => request.resource === 'plugins',
        ),
      ).toHaveLength(2);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('"Shared by me" lists only the viewer\'s own shares on every tab', async () => {
    test.setTimeout(240_000);
    const session = await launchOwnerSession('csk_can4263_ownership');
    const { electronApp, userDataDir, window, app } = session;
    try {
      await app.openPluginsPage();
      for (const tab of ['all', ...KINDS]) {
        await openTab(window, tab);
        const kinds = tab === 'all' ? KINDS : [tab];
        const shared = window.getByTestId('customize-section-shared-by-me');
        const browse = window.getByTestId('customize-section-browse');
        await expect(shared).toBeVisible({ timeout: 20_000 });
        for (const kind of kinds) {
          await expect(
            browse.getByTestId(entryTestId(kind, FOREIGN[kind])),
          ).toBeVisible({ timeout: 20_000 });
          await expect(
            shared.getByTestId(
              `customize-row-${kind}:shared:${shareId(kind, OWNED[kind])}`,
            ),
          ).toBeVisible({ timeout: 20_000 });
          await expect(
            shared.getByTestId(
              `customize-row-${kind}:shared:${shareId(kind, FOREIGN[kind])}`,
            ),
          ).toHaveCount(0);
        }
      }
      const reads = (await readMockRequests(electronApp)).filter(
        (request) => request.method === 'GET',
      );
      for (const resource of ['skills', 'collections', 'agents', 'plugins']) {
        expect(reads.some((request) => request.resource === resource)).toBe(
          true,
        );
      }

      // Empty owned sections disappear while other people's Browse rows remain.
      await electronApp.evaluate(() => {
        const { rows } = globalThis.__can4263;
        for (const kind of Object.keys(rows)) {
          rows[kind] = rows[kind].filter(
            (row) => row.createdBy.id !== 'account-e2e',
          );
        }
      });
      // The fixture changed the server externally; remount to read it again.
      await app.openAutomationsPage();
      await app.openPluginsPage();
      await openTab(window, 'collection');
      await expect(
        window.getByTestId('customize-section-shared-by-me'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(entryTestId('collection', FOREIGN.collection)),
      ).toBeVisible({ timeout: 20_000 });
      await openTab(window, 'all');
      await expect(
        window.getByTestId('customize-section-shared-by-me'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(entryTestId('skill', FOREIGN.skill)),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a collection owner edits it, the change persists, and a failed save keeps the edits', async () => {
    test.setTimeout(180_000);
    const session = await launchOwnerSession('csk_can4263_collection_edit');
    const { electronApp, userDataDir, window, app } = session;
    // Marketplace rows title-case names, so the new name is already title case.
    const renamed = 'Release Kit Collection Two';
    const described = 'Everything a release captain needs.';
    try {
      await app.openPluginsPage();
      await openEntry(window, 'collection', OWNED.collection);
      const bar = await expectUnshareLeads(window, 'collection');
      await bar.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = window.getByRole('dialog').filter({
        hasText: `Edit shared collection: ${OWNED.collection.name}`,
      });
      await expect(editor).toBeVisible();
      const nameInput = editor.getByRole('textbox', { name: /Name/ });
      const descriptionInput = editor.getByRole('textbox', {
        name: 'Description',
      });
      await expect(nameInput).toHaveValue(OWNED.collection.name);

      // A failed save keeps the editor open with every edit in place.
      await queueFailure(
        electronApp,
        'PUT',
        deletePath('collection', OWNED.collection),
        { status: 500, body: { error: 'Internal error' } },
      );
      await nameInput.fill(renamed);
      await descriptionInput.fill(described);
      await editor.getByRole('button', { name: 'Save changes' }).click();
      await expect(editor).toContainText('Failed to update shared collection.');
      await expect(nameInput).toHaveValue(renamed);
      await expect(descriptionInput).toHaveValue(described);

      await editor.getByRole('button', { name: 'Save changes' }).click();
      await expect(editor).toHaveCount(0);
      const puts = (await readMockRequests(electronApp)).filter(
        (request) => request.method === 'PUT',
      );
      expect(puts).toHaveLength(2);
      expect(JSON.parse(JSON.parse(puts[1].body).rawCollection)).toMatchObject({
        name: renamed,
        description: described,
      });

      // Reopened from browse, the detail reads the saved collection back.
      await backToBrowse(window);
      const entry = window.getByTestId(
        entryTestId('collection', OWNED.collection),
      );
      await expect(entry).toContainText(renamed, { timeout: 20_000 });
      await entry.click();
      await expect(window.getByText(described).first()).toBeVisible({
        timeout: 20_000,
      });
      await expectUnshareLeads(window, 'collection');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
