// CAN-4261 — every Customize detail reads the same way: the shared detail
// header (one visible title with the description and meta under it), at most
// three visible actions beside one ⋯ menu, no Back (the breadcrumb leads
// out), no outlined Name/Description card and no second title in the body.
//
// Each row opens one detail type from the Customize page. Types still on the
// legacy layout are listed as `fixme` rows; migrating one means deleting its
// `fixme` flag so this walk covers it.
//
// Deterministic: main's `fetch` serves the shared skill, agent and plugin
// lists and details from in-memory state; everything else goes to the shared
// mock server. No network, no live agents.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/index.mjs';

const VIEWER = { id: 'account-e2e', name: 'Portal E2E' };
const OTHER = { id: 'account-other-can4261', name: 'Other Member' };
const NOW = '2026-10-01T00:00:00.000Z';
const ORGANIZATION = {
  type: 'organization',
  id: 'org-can4261',
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
    // The legacy page showed this frontmatter as a Name/Description card and
    // the `# Title` as a second, larger title.
    rawSkill: `---\nname: ${name}\ndescription: ${name} description.\n---\n\n# ${name}\n\nWalk the release steps in order.\n`,
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

const ROWS = {
  skill: [
    skill('can4261-owned-skill', 'Release Checklist', VIEWER),
    skill('can4261-other-skill', 'Incident Triage', OTHER),
  ],
  agent: [agent('can4261-owned-agent', 'Release Captain', VIEWER)],
  plugin: [
    plugin('can4261-owned-plugin', 'Release Notes', 'release-notes', VIEWER),
  ],
};

/** Serves the shared skill, agent and plugin lists and details from state. */
async function installSharedMock(electronApp, rows, viewerId) {
  await electronApp.evaluate(
    (_electron, { initialRows, viewer }) => {
      const originalFetch = globalThis.fetch;
      const state = structuredClone(initialRows);
      const json = (status, body) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const kinds = { skills: 'skill', agents: 'agent', plugins: 'plugin' };
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
        if (!match || method !== 'GET') return originalFetch(input, init);
        const [, resource, id] = match;
        const kind = kinds[resource];
        if (!kind) {
          // Other shared kinds list nothing, so another spec's fixtures
          // never join these sections.
          if (id) return originalFetch(input, init);
          if (resource === 'automations')
            return json(200, { automations: [], nextCursor: null });
          if (resource === 'workspace-template-shares')
            return json(200, { shares: [], nextCursor: null });
          if (resource === 'collections')
            return json(200, { collections: [], nextCursor: null });
          return json(200, { data: [], nextCursor: null });
        }
        const ownedOnly = url.searchParams.get('createdBy') === 'me';
        if (!id) {
          const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
          const listed = state[kind].filter(
            (row) =>
              (!ownedOnly || row.createdBy.id === viewer) &&
              (!q || row.name.toLowerCase().includes(q)),
          );
          if (kind === 'plugin') return json(200, { data: listed });
          return json(200, { [resource]: listed, nextCursor: null });
        }
        const row = state[kind].find(
          (candidate) => idOf(kind, candidate) === decodeURIComponent(id),
        );
        return row ? json(200, row) : originalFetch(input, init);
      };
    },
    { initialRows: rows, viewer: viewerId },
  );
}

/** Opens `testId`'s row on `tab`, from Installed, Shared by me or Browse. */
async function openRow(window, tab, entryId) {
  await window.getByTestId(`plugins-type-tab-${tab}`).click();
  const row = window
    .locator(
      `[data-testid="customize-row-${entryId}"], [data-testid="plugins-entry-${entryId}"]`,
    )
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    window.getByTestId('plugins-entry-detail-breadcrumb-root'),
  ).toBeVisible();
}

/** Opens the first row of `tab`'s Installed section. */
async function openFirstInstalled(window, tab) {
  await window.getByTestId(`plugins-type-tab-${tab}`).click();
  const row = window
    .getByTestId('customize-section-installed')
    .locator('[data-testid^="customize-row-"][data-marketplace-entry]')
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    window.getByTestId('plugins-entry-detail-breadcrumb-root'),
  ).toBeVisible();
}

/** The one detail layout every Customize detail follows. */
async function expectSharedHeader(window, title) {
  const header = window
    .locator('header[data-testid$="detail-header"]')
    .filter({ visible: true });
  await expect(header).toHaveCount(1, { timeout: 20_000 });
  const heading = window.locator('h1').filter({ visible: true });
  await expect(heading).toHaveCount(1);
  if (title) await expect(heading).toHaveText(title);
  // No outlined Name/Description card and no second title in the body.
  await expect(
    window.getByText('Name:', { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(0);
  // At most three visible actions beside one ⋯ menu, and no second ⋯
  // anywhere on the page.
  const actions = header.locator('[data-testid$="detail-header-actions"]');
  const buttons = actions.locator('button').filter({ visible: true });
  const more = actions
    .locator('button[aria-label^="More actions"]')
    .filter({ visible: true });
  const moreCount = await more.count();
  expect(moreCount).toBeLessThanOrEqual(1);
  expect((await buttons.count()) - moreCount).toBeLessThanOrEqual(3);
  await expect(
    window
      .locator(
        '[data-testid="plugins-entry-detail"], [data-testid="plugins-entry-detail-page"]',
      )
      .first()
      .locator('button[aria-label^="More actions"]')
      .filter({ visible: true }),
  ).toHaveCount(moreCount);
}

const DETAILS = [
  {
    name: 'installed skill',
    open: (window) => openFirstInstalled(window, 'skill'),
  },
  {
    name: 'owned shared skill',
    title: 'Release Checklist',
    open: (window) =>
      openRow(window, 'skill', 'skill:shared:can4261-owned-skill'),
  },
  {
    name: "another member's shared skill",
    title: 'Incident Triage',
    open: (window) =>
      openRow(window, 'skill', 'skill:shared:can4261-other-skill'),
  },
  {
    name: 'shared agent',
    title: 'Release Captain',
    open: (window) =>
      openRow(window, 'agent', 'agent:shared:can4261-owned-agent'),
  },
  {
    name: 'shared plugin',
    title: 'Release Notes',
    open: (window) =>
      openRow(window, 'plugin', 'plugin:shared:can4261-owned-plugin'),
  },
  // Still on the legacy layout; migrated in CAN-4686.
  { name: 'installed plugin', fixme: true },
  { name: 'MCP server', fixme: true },
  { name: 'pipeline', fixme: true },
  { name: 'automation', fixme: true },
  { name: 'collection', fixme: true },
  { name: 'local agent', fixme: true },
];

test.describe('CAN-4261 Customize detail header', () => {
  let session;

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can4261-detail-header-'),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1400, height: 900 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, 'csk_can4261_detail_header');
    await installSharedMock(electronApp, ROWS, VIEWER.id);
    session = { electronApp, userDataDir, window, app };
  });

  test.afterAll(async () => {
    if (session) await closeCanopy(session.electronApp, session.userDataDir);
  });

  for (const detail of DETAILS) {
    const run = detail.fixme ? test.fixme : test;
    run(`${detail.name} uses the shared detail header`, async () => {
      test.setTimeout(120_000);
      const { window, app } = session;
      await app.openPluginsPage();
      await detail.open(window);
      await expectSharedHeader(window, detail.title);
      await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
      await expect(window.getByTestId('plugins-search')).toBeVisible();
    });
  }
});
