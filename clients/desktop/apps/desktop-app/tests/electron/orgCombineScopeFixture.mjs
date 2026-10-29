import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  seedOrgContextScoping,
  connectMockCloudAccount,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

export function autoConversionDiagnostics(userDataDir) {
  const directory = path.join(
    userDataDir,
    'agent-observability',
    'diagnostics',
    'session-events',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.kind === 'org_project_auto_conversion')
    .map((event) => ({
      workspaceId: event.projectId,
      outcome: event.orgProjectAutoConversionOutcome,
      reason: event.orgProjectAutoConversionReason ?? null,
    }));
}

export function initRepository(repoPath, remote) {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), `${remote}\n`);
  for (const args of [
    ['init', '--initial-branch=main'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Canopy Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial',
    ],
    ['remote', 'add', 'origin', remote],
  ])
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
}

export const ORG_COMBINE_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-shared-org-projects-enabled': true,
  }),
  CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'on',
};
const ORG_COMBINE_SECOND = 'context-organization-two';
const FIRST_PROJECT = '33333333-3333-4333-8333-333333333333';
const SECOND_PROJECT = '77777777-7777-4777-8777-777777777777';
const SENTINEL = 'can-3846-scan-sentinel';

function holder(id, organizationId, name, providerRepoId) {
  return {
    id,
    organizationId,
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name,
      providerRepoId,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

/** Every member has an explicit complete catalog, including empty Org B. */
export function seedOrgCombineScope(userDataDir, crossOrganization = false) {
  seedOrgContextScoping(userDataDir, {
    organizationWorktreeIds: ['org-feature'],
    organizationB: crossOrganization,
    extraOrganizationWorkspaces: crossOrganization
      ? []
      : [
          {
            id: ORG_COMBINE_SECOND,
            name: 'Acme second repository',
            projectId: SECOND_PROJECT,
            instanceId: '88888888-8888-4888-8888-888888888888',
            remoteUrl: 'https://github.com/acme/second-repo.git',
            worktreeIds: ['org-two-feature'],
          },
        ],
  });
  const joinWorkspaceId = crossOrganization
    ? 'context-organization-b'
    : ORG_COMBINE_SECOND;
  const joinWorktreeId = crossOrganization
    ? 'beta-org-feature'
    : 'org-two-feature';
  for (const [id, remote] of [
    ['context-organization', 'https://github.com/acme/setup-repo.git'],
    ...(crossOrganization
      ? [[joinWorkspaceId, 'https://github.com/acme/second-repo.git']]
      : []),
  ])
    execFileSync('git', ['remote', 'add', 'origin', remote], {
      cwd: path.join(userDataDir, 'repos', id),
      stdio: 'pipe',
    });
  // The indexed moved-back sentinel proves the selector visited the inventory.
  // Preparation separately awaits the persisted pass completion below.
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: SENTINEL,
    name: 'Scan sentinel',
    type: 'single-repo',
    color: '#7C9B6D',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeFileSync(indexPath, JSON.stringify(index));
  const sentinelDir = path.join(userDataDir, 'workspaces', SENTINEL);
  mkdirSync(sentinelDir, { recursive: true });
  writeFileSync(
    path.join(sentinelDir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: path.join(userDataDir, 'repos', 'context-personal'),
      repos: [],
      alwaysShow: true,
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: FIRST_PROJECT,
        convertedAt: '2026-09-01T00:00:00Z',
        movedBackAt: '2026-09-02T00:00:00Z',
      },
    }),
  );
  writeFileSync(
    path.join(sentinelDir, 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: [] }),
  );
  const secondOrg = crossOrganization ? ORG_CONTEXT_B : ORG_CONTEXT_A;
  const secondId = crossOrganization
    ? '55555555-5555-4555-8555-555555555555'
    : SECOND_PROJECT;
  const first = holder(FIRST_PROJECT, ORG_CONTEXT_A, 'setup-repo', '1');
  const second = holder(secondId, secondOrg, 'second-repo', '2');
  return {
    joinWorkspaceId,
    joinWorktreeId,
    heldIds: [FIRST_PROJECT, secondId],
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: crossOrganization ? [first] : [first, second],
        [`org:${ORG_CONTEXT_B}`]: crossOrganization ? [second] : [],
      },
    },
  };
}

export async function prepareOrgCombineScope(
  electronApp,
  userDataDir,
  apiKey,
  fixture,
) {
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  // Explicit force-refresh verifies both catalogs independently of diagnostics.
  for (const organizationId of [ORG_CONTEXT_A, ORG_CONTEXT_B]) {
    const snapshot = await window.evaluate(
      (id) =>
        window.api.orgProjects.refresh({
          context: { kind: 'organization', organizationId: id },
          force: true,
        }),
      organizationId,
    );
    expect(snapshot.stale).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.revision).not.toBe('');
    expect(snapshot.projects.map((project) => project.id).sort()).toEqual(
      fixture.cloud.orgProjects[`org:${organizationId}`]
        .map((project) => project.id)
        .sort(),
    );
  }
  await expect
    .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
    .toContainEqual({
      workspaceId: SENTINEL,
      outcome: 'skipped',
      reason: 'moved-back',
    });
  // The first scan can use catalogs cached before its pass started. Refresh
  // after the sentinel so a follow-up scan can persist settled completion.
  for (const organizationId of [ORG_CONTEXT_A, ORG_CONTEXT_B]) {
    if (fixture.cloud.orgProjects[`org:${organizationId}`].length === 0)
      continue;
    const fresh = await window.evaluate(
      (id) =>
        window.api.orgProjects.refresh({
          context: { kind: 'organization', organizationId: id },
          force: true,
        }),
      organizationId,
    );
    expect(fresh.stale).toBe(false);
    expect(fresh.error).toBeNull();
  }
  await expect
    .poll(
      () => {
        const file = path.join(
          userDataDir,
          'org-project-migration-passes.json',
        );
        if (!existsSync(file)) return false;
        const ledger = JSON.parse(readFileSync(file, 'utf8'));
        return [ORG_CONTEXT_A, ORG_CONTEXT_B]
          .filter((id) => fixture.cloud.orgProjects[`org:${id}`].length > 0)
          .every(
            (id) => typeof ledger.organizations[id]?.completedAt === 'string',
          );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const { items } = await window.evaluate(() => window.api.loadProjects());
  expect(items.filter((item) => item.type !== 'cowork').at(-1)?.id).toBe(
    SENTINEL,
  );
  await selectWorkspaceContext(window, ORG_CONTEXT_A);
  return window;
}

/** Immutable snapshot at the actual response boundary, isolated per launch. */
export async function observeOrgCombineReply(
  electronApp,
  freezeAfterReply = false,
) {
  await electronApp.evaluate(({ ipcMain }, freeze) => {
    const channel = 'workspace:combine-worktree-with-existing-worktree';
    const original = ipcMain._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing existing-worktree join handler');
    if (globalThis.can3846Observer)
      throw new Error('Reply observer already installed');
    const state = {
      channel,
      original,
      reply: null,
      elapsedMs: null,
      override: process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT,
    };
    globalThis.can3846Observer = state;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, request) => {
      const started = Date.now();
      const reply = await original(event, request);
      state.reply = structuredClone(reply);
      state.elapsedMs = Date.now() - started;
      // Capture-only: inline is complete; disable later scans before renderer
      // receives the reply. No post-modal fetch race and no uncancelled work.
      if (freeze) process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT = 'off';
      return reply;
    });
  }, freezeAfterReply);
}

export async function restoreOrgCombineReply(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const state = globalThis.can3846Observer;
    if (!state) return;
    ipcMain.removeHandler(state.channel);
    ipcMain.handle(state.channel, state.original);
    if (state.override === undefined)
      delete process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT;
    else process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT = state.override;
    delete globalThis.can3846Observer;
  });
}

export function orgCombineDestinationRow(window, reply) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${reply.destinationWorkspaceId}"][data-worktree-id="${reply.destinationWorktreeId}"]`,
  );
}

export async function joinOrgCombineScope(window, electronApp, fixture) {
  const row = window.locator(
    '[data-testid="worktree-row"][data-project-id="context-organization"][data-worktree-id="org-feature"]',
  );
  await expect(row).toBeVisible();
  // The report starts in the source worktree. Enter it before opening its
  // actions, so the flow also verifies destination selection from that state.
  await row.click();
  await expect(
    window.locator(
      '[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="context-organization"][data-worktree-id="org-feature"]',
    ),
  ).toHaveCount(1);
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-add-repo').click();
  const modal = window.getByTestId('add-repo-to-worktree-modal');
  await expect(modal).toBeVisible();
  await modal.getByTestId('add-repo-to-worktree-modal-pill-existing').click();
  await modal
    .getByTestId(
      `existing-worktree-picker-option-${fixture.joinWorkspaceId}-${fixture.joinWorktreeId}`,
    )
    .click();
  const joinStarted = Date.now();
  await modal.getByTestId('add-repo-to-worktree-modal-submit').click();
  await expect(modal).toHaveCount(0, { timeout: 60_000 });
  const observed = await electronApp.evaluate(() => ({
    reply: globalThis.can3846Observer.reply,
    elapsedMs: globalThis.can3846Observer.elapsedMs,
  }));
  expect(observed.reply).not.toBeNull();
  return { ...observed, visibleMs: Date.now() - joinStarted };
}
