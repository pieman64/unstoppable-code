import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import { seedAutomationTargetProjects } from './automationTargetFixtures.mjs';
import {
  createFixture as createCodexFixture,
  protocolRequests,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedAutomations,
  seedCoworkWorkspace,
  registerShareMembership,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  SHARE_MEMBERSHIP_ORGANIZATION,
  ORG_CONTEXT_ENV,
} from './seeders/index.mjs';

// Shared-Automation install/update wizard (CAN-1581 PR9).
//
// The offline harness has no cloud account, so the browse surface (list +
// detail fetch) cannot be exercised end-to-end; that is the one genuinely
// cloud-bound boundary. Everything downstream of it is driven here through
// the E2E-only fixture seam (`canopy:automations-e2e-install-fixture`, dead
// code in production builds via `__CANOPY_E2E__`): the event injects a
// validated portable document as the selected share, and from there the REAL
// wizard, rebind mappers, automations IPC, service, and on-disk persistence
// all run unmocked. The install path asserts the persisted provenance
// (`installedFrom`) and disabled-by-default contract; the update path seeds
// two stale installed copies and asserts the copy picker retargets the
// update to the chosen copy while leaving the other untouched.
//
// A cowork workspace is seeded as the binding target because it needs no git
// checkout (worktree_pipeline actions accept cowork targets; the run is
// directory-scoped at the cowork root).

const REMOTE_ID = '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111';
const NEW_HASH = 'a'.repeat(64);
const OLD_HASH = 'b'.repeat(64);
const WORKSPACE_ID = 'seeded-cowork';
const PACKAGED_SKILL_ID = 'packaged-automation-review';
const PACKAGED_SKILL_BYTES = Buffer.from(
  [
    '---',
    'name: packaged-automation-review',
    'description: Packaged automation E2E fixture',
    '---',
    '# Packaged automation review',
    'Review the current work and report the result.',
    '',
  ].join('\n'),
);
const PACKAGED_SKILL_HASH = createHash('sha256')
  .update(PACKAGED_SKILL_BYTES)
  .digest('hex');
const CAPABILITY_PACKAGE_MANIFEST = {
  version: 1,
  pipelineContentHash: NEW_HASH,
  resources: [
    {
      id: PACKAGED_SKILL_ID,
      kind: 'standalone_skill',
      displayName: '$packaged-automation-review',
      sourceLabel: 'Private automation fixture',
      sourceVisibility: 'private',
      invocationKeys: ['$packaged-automation-review'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'codex',
          runtimeKind: 'standalone_skill',
          rootName: PACKAGED_SKILL_ID,
          entries: [
            {
              path: 'SKILL.md',
              sha256: PACKAGED_SKILL_HASH,
              size: PACKAGED_SKILL_BYTES.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    },
  ],
  bindings: [
    {
      jobId: 'automation',
      stepId: 'action',
      resourceIds: [PACKAGED_SKILL_ID],
    },
  ],
  environmentRequirements: [],
  totalFiles: 1,
  totalBytes: PACKAGED_SKILL_BYTES.byteLength,
};
const CAPABILITY_PACKAGE_DIGEST = `pp:v1:${createHash('sha256')
  .update(JSON.stringify(CAPABILITY_PACKAGE_MANIFEST))
  .digest('base64url')}`;

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
}

function fixtureDocument() {
  return {
    version: 1,
    name: 'Nightly review pipeline',
    description: 'Seeded E2E share fixture',
    trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'workspace' },
      pipeline: {
        source: 'bundled',
        pipelineId: 'bundled-code-review-multi-provider',
      },
      inputKeys: ['base_branch'],
    },
    hasRunCondition: false,
  };
}

function coworkFixtureDocument() {
  return {
    version: 1,
    name: 'Daily cowork summary',
    description: 'Portable Cowork prompt',
    trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'standalone_prompt',
      target: { kind: 'cowork' },
      prompt: 'Summarize today.',
      plugins: [],
    },
    hasRunCondition: false,
  };
}

function packagedCoworkFixtureDocument() {
  return {
    ...coworkFixtureDocument(),
    name: 'Packaged cowork review',
    action: {
      ...coworkFixtureDocument().action,
      prompt: 'Use $packaged-automation-review to review this work.',
    },
    capabilityPackage: {
      version: 1,
      digest: CAPABILITY_PACKAGE_DIGEST,
    },
  };
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const SHARE_ORGANIZATION_ID = '3a1f6c2e-8d4b-4f7a-9c1e-2b5d8e7f6a90';

function startAutomationPackageCloud() {
  const capabilities = [
    'pipelines-crud-v1',
    'account-v1',
    'organizations-v1',
    'teams-v1',
    'automations-crud-v1',
  ];
  const committedPackageUploadId = '6f6b0f5e-2f66-4be4-9f8e-1f0a54a1c333';
  const sharedAutomationRequests = [];
  // Automations are shared with a team or organization (or publicly); this
  // account belongs to one organization and no team.
  const organization = {
    id: SHARE_ORGANIZATION_ID,
    name: 'Automation Package Org',
    role: 'MEMBER',
    createdAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      request.method === 'GET' &&
      (url.pathname === '/.well-known/canopy' ||
        url.pathname === '/.well-known/unstoppable-code')
    ) {
      sendJson(response, 200, { capabilities });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/desktop-app/account'
    ) {
      sendJson(response, 200, {
        account: {
          id: 'automation-package-e2e',
          name: 'Automation Package E2E',
          email: 'automation-package@example.test',
          role: 'ADMIN',
        },
        capabilities,
        organizations: [organization],
        teams: [],
      });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/desktop-app/organizations'
    ) {
      sendJson(response, 200, { data: [organization], nextCursor: null });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/api/v1/desktop-app/automations'
    ) {
      sendJson(response, 200, { automations: [], nextCursor: null });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === `/api/v1/automations/${REMOTE_ID}/package`
    ) {
      sendJson(response, 200, {
        digest: CAPABILITY_PACKAGE_DIGEST,
        manifest: CAPABILITY_PACKAGE_MANIFEST,
      });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname ===
        `/api/v1/automations/${REMOTE_ID}/package/blobs/${PACKAGED_SKILL_HASH}`
    ) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(PACKAGED_SKILL_BYTES.byteLength),
      });
      response.end(PACKAGED_SKILL_BYTES);
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/v1/pipeline-packages/uploads'
    ) {
      sendJson(response, 200, {
        uploadId: committedPackageUploadId,
        expiresAt: '2099-01-01T00:00:00.000Z',
        missingBlobs: [],
      });
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname ===
        `/api/v1/pipeline-packages/uploads/${committedPackageUploadId}/commit`
    ) {
      sendJson(response, 200, {
        uploadId: committedPackageUploadId,
        digest: CAPABILITY_PACKAGE_DIGEST,
        package: {
          digest: CAPABILITY_PACKAGE_DIGEST,
          version: 1,
          resources: CAPABILITY_PACKAGE_MANIFEST.resources,
          environmentRequirements: [],
          totalFiles: CAPABILITY_PACKAGE_MANIFEST.totalFiles,
          totalBytes: CAPABILITY_PACKAGE_MANIFEST.totalBytes,
        },
      });
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/v1/desktop-app/automations'
    ) {
      void readJsonRequest(request)
        .then((body) => {
          sharedAutomationRequests.push(body);
          const now = '2026-09-18T12:00:00.000Z';
          sendJson(response, 201, {
            id: '7f6b0f5e-2f66-4be4-9f8e-1f0a54a1c444',
            name: body.automation.name,
            description: body.automation.description,
            triggerKind: body.automation.trigger.kind,
            actionType: body.automation.action.type,
            contentHash: 'd'.repeat(64),
            shareScope: body.shareScope ?? 'private',
            owner:
              body.shareScope === 'organization'
                ? {
                    type: 'organization',
                    id: body.organizationId,
                    name: organization.name,
                  }
                : {
                    type: 'user',
                    id: 'automation-package-e2e',
                    name: 'Automation Package E2E',
                  },
            createdAt: now,
            updatedAt: now,
            createdBy: {
              id: 'automation-package-e2e',
              name: 'Automation Package E2E',
              email: 'automation-package@example.test',
            },
            canUpdate: true,
            canDelete: true,
            automation: body.automation,
          });
        })
        .catch((error) => {
          sendJson(response, 400, { error: String(error) });
        });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        committedPackageUploadId,
        sharedAutomationRequests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function makeInstalledCopy({ id, name, contentHash }) {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: WORKSPACE_ID,
      pipelineId: 'bundled-code-review-multi-provider',
      pipelineSource: 'bundled',
      inputs: { base_branch: 'develop' },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureCount: 0,
    installedFrom: {
      remoteId: REMOTE_ID,
      contentHash,
      installedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function readPersistedActivities(userDataDir) {
  return readPersistedAutomationFile(userDataDir).activities ?? [];
}

function readPersistedAutomationFile(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'automations.json'), 'utf8'),
  );
}

// The install-fixture seam is always mounted (CAN-3980), so it no longer
// needs the retired Automations › Shared tab. Specs inject from Workflows ›
// Library so the installed copy lists right behind the wizard.
async function openAutomationsAndInjectFixture(window, app) {
  await app.waitForShell();
  await app.openAutomationsPage();
  await window.evaluate(
    ({ id, contentHash, document }) => {
      window.dispatchEvent(
        new CustomEvent('canopy:automations-e2e-install-fixture', {
          detail: { id, contentHash, document },
        }),
      );
    },
    { id: REMOTE_ID, contentHash: NEW_HASH, document: fixtureDocument() },
  );
  await expect(
    window.getByTestId('install-shared-automation-modal'),
  ).toBeVisible();
}

test('install wizard: binds a project and persists an enabled copy with provenance', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await openAutomationsAndInjectFixture(window, app);

    // Fresh install mode: submit is gated on the workspace binding, and the
    // footer names the missing input instead of reading as unavailable. One
    // click installs and enables; there is no Cancel (CAN-3651).
    const submitButton = window.getByTestId('install-automation-submit');
    await expect(submitButton).toBeDisabled();
    await expect(submitButton).toHaveText('Install and enable');
    // The busy state and its spinner show only while an install runs.
    await expect(submitButton).toHaveAttribute('aria-busy', 'false');
    await expect(
      window.getByTestId('install-automation-submit-spinner'),
    ).toHaveCount(0);
    await expect(window.getByTestId('install-automation-note')).toHaveCount(0);
    await expect(
      window
        .getByTestId('install-shared-automation-modal')
        .getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('install-automation-submit-reason'),
    ).toHaveText('Choose a project to continue');
    await window
      .getByTestId('install-automation-workspace')
      .selectOption(WORKSPACE_ID);
    await expect(
      window.getByTestId('install-automation-submit-reason'),
    ).toHaveCount(0);
    await window
      .getByTestId('install-automation-input-base_branch')
      .fill('develop');
    await expect(window.getByTestId('install-automation-submit')).toBeEnabled();
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    // The real IPC/service round-trip persisted the copy: turned on, carrying
    // provenance and the bound inputs.
    await expect
      .poll(() => readPersistedActivities(userDataDir)[0]?.enabled ?? null)
      .toBe(true);
    const [activity] = readPersistedActivities(userDataDir);
    expect(readPersistedActivities(userDataDir)).toHaveLength(1);
    expect(activity.name).toBe('Nightly review pipeline');
    expect(activity.action.workspaceId).toBe(WORKSPACE_ID);
    expect(activity.action.inputs).toEqual({ base_branch: 'develop' });
    expect(activity.installedFrom.remoteId).toBe(REMOTE_ID);
    expect(activity.installedFrom.contentHash).toBe(NEW_HASH);

    // The installed copy also lists on Workflows › Library.
    await expect(
      window.getByTestId('workflows-tab-workflows-library'),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      window.getByText('Nightly review pipeline').first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('install wizard: binds a Cowork project for a portable prompt', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // The seam works from any page: inject from the Home page a fresh
    // launch lands on, with no Workflows page mounted.
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(window.getByTestId('page-workflows')).toHaveCount(0);
    await window.evaluate(
      ({ id, contentHash, document }) => {
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        );
      },
      {
        id: REMOTE_ID,
        contentHash: NEW_HASH,
        document: coworkFixtureDocument(),
      },
    );

    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();
    await window
      .getByTestId('install-automation-cowork-project')
      .selectOption(WORKSPACE_ID);
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    await expect
      .poll(() => readPersistedActivities(userDataDir)[0]?.enabled ?? null)
      .toBe(true);
    const [activity] = readPersistedActivities(userDataDir);
    expect(readPersistedActivities(userDataDir)).toHaveLength(1);
    expect(activity.action).toMatchObject({
      type: 'standalone_prompt',
      chatProjectId: WORKSPACE_ID,
      prompt: 'Summarize today.',
    });
    expect(activity.installedFrom).toMatchObject({
      remoteId: REMOTE_ID,
      contentHash: NEW_HASH,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('install wizard: installs a share with file references without a confirmation checkbox', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const document = coworkFixtureDocument();
    document.version = 2;
    document.action.prompt = 'Read README.md';
    document.action.promptReferences = [
      {
        kind: 'file',
        textStart: 5,
        displayText: 'README.md',
        root: { kind: 'workspace' },
        relativePath: '.env',
      },
    ];
    await window.evaluate(
      ({ id, contentHash, document }) => {
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        );
      },
      { id: REMOTE_ID, contentHash: NEW_HASH, document },
    );

    const modal = window.getByTestId('install-shared-automation-modal');
    await expect(modal).toBeVisible();
    await modal
      .getByTestId('install-automation-cowork-project')
      .selectOption(WORKSPACE_ID);
    // CAN-3710: clicking Install is the confirmation; no file opt-in gates it.
    await expect(
      modal.getByTestId('install-automation-confirm-files'),
    ).toHaveCount(0);
    await expect(modal.getByTestId('install-automation-submit')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('install wizard: reviews, materializes, and runs a packaged capability', async () => {
  test.setTimeout(120_000);
  const cloud = await startAutomationPackageCloud();
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  seedPreferences(userDataDir);
  const codexFixture = createCodexFixture('normal', 'Packaged run complete');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...codexFixture.env,
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_automation_package_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openAutomationsPage();
    const modal = window.getByTestId('install-shared-automation-modal');
    const fixturePayload = {
      id: REMOTE_ID,
      contentHash: NEW_HASH,
      document: packagedCoworkFixtureDocument(),
    };
    await expect
      .poll(async () => {
        if ((await modal.count()) > 0) return true;
        await window.evaluate(({ id, contentHash, document }) => {
          window.dispatchEvent(
            new CustomEvent('canopy:automations-e2e-install-fixture', {
              detail: { id, contentHash, document },
            }),
          );
        }, fixturePayload);
        return false;
      })
      .toBe(true);
    await expect(modal).toBeVisible();
    // CAN-3710: the review stays light; the package is not listed in it.
    await expect(
      modal.getByTestId('capability-package-included-resources'),
    ).toHaveCount(0);
    await modal
      .getByTestId('install-automation-cowork-project')
      .selectOption(WORKSPACE_ID);
    await modal.getByTestId('install-automation-submit').click();
    await expect(modal).toBeHidden();

    await expect
      .poll(() => readPersistedActivities(userDataDir).length)
      .toBe(1);
    const [activity] = readPersistedActivities(userDataDir);
    expect(activity.installedFrom.capabilityPackage).toEqual({
      version: 1,
      digest: CAPABILITY_PACKAGE_DIGEST,
    });
    const materializedSkill = path.join(
      userDataDir,
      'pipeline-packages',
      'v1',
      'packages',
      CAPABILITY_PACKAGE_DIGEST.slice('pp:v1:'.length),
      'materialized',
      PACKAGED_SKILL_ID,
      'codex',
      PACKAGED_SKILL_ID,
      'SKILL.md',
    );
    expect(existsSync(materializedSkill)).toBe(true);
    expect(readFileSync(materializedSkill, 'utf8')).toContain(
      'Packaged automation review',
    );

    await expect(
      window.getByTestId('workflows-tab-workflows-library'),
    ).toHaveAttribute('aria-selected', 'true');
    await app
      .workflowsLibraryAutomationRow(activity.id)
      .getByTestId('workflows-library-run')
      .click();
    await expect
      .poll(
        () =>
          protocolRequests(codexFixture.logPath).find(
            (request) =>
              request.method === 'thread/start' &&
              request.params?.selectedCapabilityRoots?.length === 1,
          ),
        { timeout: 60_000 },
      )
      .toBeTruthy();
    const startRequest = protocolRequests(codexFixture.logPath).find(
      (request) =>
        request.method === 'thread/start' &&
        request.params?.selectedCapabilityRoots?.length === 1,
    );
    const capabilityRootUrl =
      startRequest.params.selectedCapabilityRoots[0].location.path;
    expect(capabilityRootUrl).toEqual(expect.stringMatching(/^file:/));
    expect(existsSync(fileURLToPath(capabilityRootUrl))).toBe(true);
    await expect
      .poll(
        () =>
          readPersistedAutomationFile(userDataDir).recentRuns?.find(
            (run) => run.activityId === activity.id,
          )?.status,
        { timeout: 60_000 },
      )
      .toBe('success');

    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(activity.id),
      'share',
    );
    const shareModal = window.getByTestId('share-automation-modal');
    await expect(shareModal).toBeVisible();
    // With no team, Organization is the preselected audience.
    await expect(
      shareModal.getByTestId('share-automation-scope-organization'),
    ).toHaveAttribute('aria-checked', 'true');
    await shareModal
      .getByTestId(
        `share-automation-organization-picker-option-${SHARE_ORGANIZATION_ID}`,
      )
      .click();
    // The package travels with the share without a separate consent step.
    await expect(
      shareModal.getByTestId('share-automation-consent'),
    ).toHaveCount(0);
    await expect(
      shareModal.getByTestId('share-automation-submit'),
    ).toBeEnabled();
    await shareModal.getByTestId('share-automation-submit').click();
    await expect.poll(() => cloud.sharedAutomationRequests.length).toBe(1);
    expect(cloud.sharedAutomationRequests[0]).toMatchObject({
      shareScope: 'organization',
      organizationId: SHARE_ORGANIZATION_ID,
      committedPackageUploadId: cloud.committedPackageUploadId,
      automation: {
        capabilityPackage: {
          version: 1,
          digest: CAPABILITY_PACKAGE_DIGEST,
        },
      },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
    rmSync(codexFixture.runtimeDir, { recursive: true, force: true });
  }
});

function readPersistedActivitiesIfAny(userDataDir) {
  return existsSync(path.join(userDataDir, 'automations.json'))
    ? readPersistedActivities(userDataDir)
    : [];
}

async function injectFixture(window, document) {
  await window.evaluate(
    ({ id, contentHash, document }) => {
      window.dispatchEvent(
        new CustomEvent('canopy:automations-e2e-install-fixture', {
          detail: { id, contentHash, document },
        }),
      );
    },
    { id: REMOTE_ID, contentHash: NEW_HASH, document },
  );
}

// CAN-3980 install coverage: every way out of the wizard writes nothing, a
// failed install leaves no partial copy, and a double click installs once.
test('install wizard: dismissals and a failed install write nothing, and a double click installs once', async () => {
  test.setTimeout(120_000);
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'doomed-cowork',
    name: 'Doomed Cowork',
    chatId: 'doomed-cowork-chat',
    chatTitle: 'Doomed Cowork Chat',
    mergeIndex: true,
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    const modal = window.getByTestId('install-shared-automation-modal');
    const picker = window.getByTestId('install-automation-cowork-project');
    const submit = window.getByTestId('install-automation-submit');
    // The Library lists pipelines in the same table, so count automation rows.
    const automationRows = window.locator(
      '[data-testid="workflows-library-row"][data-row-kind="automation"]',
    );

    // Close, Escape and the backdrop each dismiss the review untouched.
    const dismissals = [
      async () =>
        modal.getByRole('button', { name: 'Close', exact: true }).click(),
      async () => window.keyboard.press('Escape'),
      async () => {
        const box = await modal.boundingBox();
        expect(box).not.toBeNull();
        // Left of the dialog, below the titlebar: only the backdrop is there.
        await window.mouse.click(
          Math.max(4, box.x / 2),
          box.y + box.height / 2,
        );
      },
    ];
    for (const dismiss of dismissals) {
      await injectFixture(window, coworkFixtureDocument());
      await expect(modal).toBeVisible();
      await picker.selectOption(WORKSPACE_ID);
      await dismiss();
      await expect(modal).toHaveCount(0);
      expect(readPersistedActivitiesIfAny(userDataDir)).toEqual([]);
    }
    await expect(automationRows).toHaveCount(0);

    // A target that disappears before submit fails the install: the review
    // stays open with the error, and nothing is persisted.
    await injectFixture(window, coworkFixtureDocument());
    await expect(modal).toBeVisible();
    await picker.selectOption('doomed-cowork');
    await window.evaluate(() =>
      window.api.deleteWorkspace({ workspaceId: 'doomed-cowork' }),
    );
    await submit.click();
    await expect(window.getByTestId('install-automation-error')).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(picker).toHaveValue('');
    expect(readPersistedActivitiesIfAny(userDataDir)).toEqual([]);
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // A double click on Install and enable creates exactly one copy.
    await injectFixture(window, coworkFixtureDocument());
    await expect(modal).toBeVisible();
    await picker.selectOption(WORKSPACE_ID);
    await expect(submit).toBeEnabled();
    await submit.dblclick();
    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => readPersistedActivitiesIfAny(userDataDir).length)
      .toBe(1);
    await window.waitForTimeout(500);
    const activities = readPersistedActivitiesIfAny(userDataDir);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      enabled: true,
      action: { type: 'standalone_prompt', chatProjectId: WORKSPACE_ID },
      installedFrom: { remoteId: REMOTE_ID, contentHash: NEW_HASH },
    });
    await expect(automationRows).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('update wizard: copy picker retargets the update to the chosen stale copy', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  seedAutomations({
    userDataDir,
    activities: [
      makeInstalledCopy({
        id: 'copy-first',
        name: 'First copy',
        contentHash: OLD_HASH,
      }),
      makeInstalledCopy({
        id: 'copy-second',
        name: 'Second copy',
        contentHash: OLD_HASH,
      }),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await openAutomationsAndInjectFixture(window, app);

    // Both seeded copies are stale, so the wizard is in update mode and
    // offers the disambiguation picker.
    await expect(window.getByTestId('install-automation-submit')).toHaveText(
      'Apply update',
    );
    const picker = window.getByTestId('install-automation-copy');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveCount(2);

    // Retarget to the second copy; its bindings prefill so submit is live.
    await picker.selectOption('copy-second');
    await expect(window.getByTestId('install-automation-submit')).toBeEnabled();
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    // Only the chosen copy was refreshed; the first stays stale (and still
    // reachable for its own apply-update pass — the round-5 masking bug).
    await expect
      .poll(
        () =>
          readPersistedActivities(userDataDir).find(
            (a) => a.id === 'copy-second',
          )?.installedFrom?.contentHash,
      )
      .toBe(NEW_HASH);
    const activities = readPersistedActivities(userDataDir);
    const first = activities.find((a) => a.id === 'copy-first');
    const second = activities.find((a) => a.id === 'copy-second');
    expect(first.installedFrom.contentHash).toBe(OLD_HASH);
    expect(second.enabled).toBe(true);
    expect(second.action.inputs).toEqual({ base_branch: 'develop' });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3959: an author-included run condition is shown but off by default,
// and is stored only when the recipient turns it on and installs.
const RUN_CONDITION = 'test -f "$HOME/.capacity-ok"';

function withRunCondition(document) {
  return {
    ...document,
    version: 4,
    hasRunCondition: true,
    runCondition: { command: RUN_CONDITION },
  };
}

for (const approve of [true, false]) {
  test(`run condition: ${approve ? 'approving stores' : 'declining omits'} the shared command`, async () => {
    const userDataDir = makeUserDataDir();
    seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await injectFixture(window, withRunCondition(coworkFixtureDocument()));
      await expect(
        window.getByTestId('install-shared-automation-modal'),
      ).toBeVisible();

      const toggle = window.getByTestId(
        'install-automation-run-condition-toggle',
      );
      const command = window.getByTestId(
        'install-automation-run-condition-command',
      );
      await expect(toggle).not.toBeChecked();
      await expect(command).toHaveValue(RUN_CONDITION);
      await expect(command).toHaveAttribute('readonly', '');
      if (approve) {
        await toggle.check();
        await expect(command).not.toHaveAttribute('readonly', '');
      }
      await window
        .getByTestId('install-automation-cowork-project')
        .selectOption(WORKSPACE_ID);
      await window.getByTestId('install-automation-submit').click();
      await expect(
        window.getByTestId('install-shared-automation-modal'),
      ).toBeHidden();

      await expect
        .poll(() => readPersistedActivities(userDataDir).length)
        .toBe(1);
      const [activity] = readPersistedActivities(userDataDir);
      if (approve) {
        expect(activity.ifCommand).toBe(RUN_CONDITION);
        expect(activity.installedFrom.approvedRunCondition).toBe(RUN_CONDITION);
      } else {
        expect(activity.ifCommand).toBeUndefined();
        expect(activity.installedFrom.approvedRunCondition).toBeUndefined();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('run condition: declining a changed command on update keeps the local one', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  seedAutomations({
    userDataDir,
    activities: [
      {
        ...makeInstalledCopy({
          id: 'gated-copy',
          name: 'Gated copy',
          contentHash: OLD_HASH,
        }),
        ifCommand: 'exit 1',
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await injectFixture(window, withRunCondition(fixtureDocument()));
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();

    await expect(window.getByTestId('install-automation-submit')).toHaveText(
      'Apply update',
    );
    await expect(
      window.getByTestId('install-automation-run-condition-keeps-current'),
    ).toHaveText('Leaving this off keeps your current command.');
    await expect(
      window.getByTestId('install-automation-run-condition-toggle'),
    ).not.toBeChecked();
    await expect(window.getByTestId('install-automation-submit')).toBeEnabled();
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    await expect
      .poll(
        () =>
          readPersistedActivities(userDataDir)[0]?.installedFrom?.contentHash,
      )
      .toBe(NEW_HASH);
    expect(readPersistedActivities(userDataDir)[0]?.ifCommand).toBe('exit 1');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('run condition: approving a changed command on update lands disabled', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  seedAutomations({
    userDataDir,
    activities: [
      {
        ...makeInstalledCopy({
          id: 'gated-copy',
          name: 'Gated copy',
          contentHash: OLD_HASH,
        }),
        ifCommand: 'exit 1',
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await injectFixture(window, withRunCondition(fixtureDocument()));
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();

    await window.getByTestId('install-automation-run-condition-toggle').check();
    await expect(
      window.getByTestId('install-automation-run-condition-turns-off'),
    ).toHaveText(
      'The automation turns off after this update so you can check it first.',
    );
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    await expect
      .poll(
        () =>
          readPersistedActivities(userDataDir)[0]?.installedFrom?.contentHash,
      )
      .toBe(NEW_HASH);
    const [activity] = readPersistedActivities(userDataDir);
    expect(activity.ifCommand).toBe(RUN_CONDITION);
    expect(activity.enabled).toBe(false);
    expect(activity.installedFrom.approvedRunCondition).toBe(RUN_CONDITION);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('run condition: an update without the command removes a shared gate', async () => {
  const userDataDir = makeUserDataDir();
  seedCoworkWorkspace({ userDataDir, workspaceId: WORKSPACE_ID });
  const copy = makeInstalledCopy({
    id: 'gated-copy',
    name: 'Gated copy',
    contentHash: OLD_HASH,
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        ...copy,
        ifCommand: RUN_CONDITION,
        installedFrom: {
          ...copy.installedFrom,
          approvedRunCondition: RUN_CONDITION,
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await injectFixture(window, fixtureDocument());
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();

    await expect(
      window.getByTestId('install-automation-run-condition-removed'),
    ).toHaveText(
      'The author removed the run condition, so this update removes yours too.',
    );
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    await expect
      .poll(
        () =>
          readPersistedActivities(userDataDir)[0]?.installedFrom?.contentHash,
      )
      .toBe(NEW_HASH);
    const [activity] = readPersistedActivities(userDataDir);
    expect(activity.ifCommand).toBeUndefined();
    expect(activity.installedFrom.approvedRunCondition).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3734: a missing compatible project offers creation without losing the share', async ({
  request,
}) => {
  const document = {
    ...coworkFixtureDocument(),
    name: 'Daily Code summary',
    action: {
      type: 'worktree_prompt',
      target: { kind: 'workspace' },
      prompt: 'Summarize today.',
      plugins: [],
    },
  };
  const apiKey = 'csk_can3734_creation';
  await registerShareMembership(apiKey);
  const published = await request.post(
    `${DEFAULT_MOCK_BASE_URL}/api/v1/canopy/automations`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      data: { automation: document, shareScope: 'private' },
    },
  );
  expect(published.ok()).toBe(true);
  const shared = await published.json();
  const userDataDir = makeUserDataDir();
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, SHARE_MEMBERSHIP_ORGANIZATION.id);
    await app.openAutomationsPage();
    await window.evaluate(
      ({ id, contentHash, document }) => {
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        );
      },
      {
        id: shared.id,
        contentHash: shared.contentHash,
        document,
      },
    );
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('install-automation-target-empty'),
    ).toBeVisible();
    await window.getByTestId('install-automation-create-worktree').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toHaveCount(0);
    await expect(window.getByTestId('add-workspace-modal')).toBeVisible();
    await window
      .getByTestId('add-workspace-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toContainText('Daily Code summary');
    await expect(
      window.getByTestId('install-automation-target-empty'),
    ).toBeVisible();
    await expect(
      window.getByTestId('install-automation-create-worktree'),
    ).toBeVisible();
    await window.getByTestId('install-automation-create-worktree').click();
    await expect(
      window.getByTestId('add-workspace-type-single-repo'),
    ).toHaveAttribute('aria-pressed', 'true');
    await window
      .getByTestId('add-workspace-name-input')
      .fill('Automation Research');
    await window.getByTestId('add-workspace-create-submit').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeVisible();
    const createdPicker = window.getByTestId('install-automation-workspace');
    await expect(createdPicker).not.toHaveValue('');
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toHaveCount(0);
    expect(readPersistedActivities(userDataDir)[0]).toMatchObject({
      enabled: true,
      action: { type: 'worktree_prompt' },
      installedFrom: { remoteId: shared.id },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3734: narrowed pipeline survives install and reload and main rejects a forged target', async () => {
  const userDataDir = makeUserDataDir();
  seedAutomationTargetProjects(userDataDir);
  const rawPipeline =
    'name: Narrowed fixture\non: dispatch\nscope: directory\njobs: {}\n';
  const document = {
    ...fixtureDocument(),
    version: 3,
    targetRequirement: { contexts: ['cowork'] },
    action: {
      ...fixtureDocument().action,
      pipeline: {
        source: 'inline',
        name: 'Narrowed fixture',
        rawPipeline,
        pipelineContentHash: createHash('sha256')
          .update(rawPipeline)
          .digest('hex'),
      },
      inputKeys: [],
    },
  };
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await window.evaluate(
      ({ id, contentHash, document }) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        ),
      { id: REMOTE_ID, contentHash: NEW_HASH, document },
    );
    const picker = window.getByTestId('install-automation-workspace');
    await expect(picker.locator('option[value="seeded-cowork"]')).toHaveCount(
      1,
    );
    await expect(
      picker.locator('option[value="demo-ts-pnpm-vite"]'),
    ).toHaveCount(0);
    await picker.selectOption('seeded-cowork');
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();
    const [stored] = readPersistedActivities(userDataDir);
    expect(stored.targetRequirement).toEqual({ contexts: ['cowork'] });
    const refused = await window.evaluate(
      (activity) =>
        window.api.automations.update({
          id: activity.id,
          action: { ...activity.action, workspaceId: 'demo-ts-pnpm-vite' },
        }),
      stored,
    );
    expect(refused).toMatchObject({ ok: false });
    expect(readPersistedActivities(userDataDir)[0].action.workspaceId).toBe(
      'seeded-cowork',
    );
    const listed = await window.evaluate(() => window.api.automations.list());
    expect(
      listed.activities.find((a) => a.id === stored.id).targetRequirement,
    ).toEqual({ contexts: ['cowork'] });
    // The incoming declaration invalidates the old binding. Nothing changes
    // until the recipient explicitly picks Code; application lands disabled.
    const updatedDocument = {
      ...document,
      targetRequirement: { contexts: ['worktree'] },
    };
    await window.evaluate(
      ({ id, contentHash, document }) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        ),
      { id: REMOTE_ID, contentHash: 'd'.repeat(64), document: updatedDocument },
    );
    await expect(
      picker.locator('option[value="demo-ts-pnpm-vite"]'),
    ).toHaveCount(1);
    await expect(picker.locator('option[value="seeded-cowork"]')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('install-automation-submit'),
    ).toBeDisabled();
    // Reopening after a completed install starts idle, not busy.
    await expect(
      window.getByTestId('install-automation-submit'),
    ).toHaveAttribute('aria-busy', 'false');
    expect(readPersistedActivities(userDataDir)[0].targetRequirement).toEqual({
      contexts: ['cowork'],
    });
    await picker.selectOption('demo-ts-pnpm-vite');
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();
    const updated = readPersistedActivities(userDataDir)[0];
    expect(updated).toMatchObject({
      id: stored.id,
      enabled: false,
      targetRequirement: { contexts: ['worktree'] },
      action: { workspaceId: 'demo-ts-pnpm-vite' },
      installedFrom: { contentHash: 'd'.repeat(64) },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3734: a republished legacy code prompt requires Cowork re-selection and updates disabled', async () => {
  const userDataDir = makeUserDataDir();
  seedAutomationTargetProjects(userDataDir);
  const legacy = {
    ...makeInstalledCopy({
      id: 'legacy-misconverted',
      name: 'Old code copy',
      contentHash: OLD_HASH,
    }),
    action: {
      type: 'worktree_prompt',
      workspaceId: 'demo-ts-pnpm-vite',
      prompt: 'Summarize today.',
    },
  };
  seedAutomations({ userDataDir, activities: [legacy] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    await window.evaluate(
      ({ id, contentHash, document }) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: { id, contentHash, document },
          }),
        ),
      {
        id: REMOTE_ID,
        contentHash: NEW_HASH,
        document: coworkFixtureDocument(),
      },
    );
    const modal = window.getByTestId('install-shared-automation-modal');
    await expect(modal.getByTestId('install-automation-submit')).toHaveText(
      'Apply update',
    );
    await expect(
      window.getByTestId('install-automation-submit'),
    ).toBeDisabled();
    expect(readPersistedActivities(userDataDir)[0].action.type).toBe(
      'worktree_prompt',
    );
    expect(
      readPersistedActivities(userDataDir)[0].installedFrom.contentHash,
    ).toBe(OLD_HASH);
    const picker = window.getByTestId('install-automation-cowork-project');
    await expect(
      picker.locator('option[value="demo-ts-pnpm-vite"]'),
    ).toHaveCount(0);
    await picker.selectOption('seeded-cowork');
    await window.getByTestId('install-automation-submit').click();
    await expect(modal).toBeHidden();
    expect(readPersistedActivities(userDataDir)[0]).toMatchObject({
      id: legacy.id,
      enabled: false,
      action: { type: 'standalone_prompt', chatProjectId: 'seeded-cowork' },
      installedFrom: { contentHash: NEW_HASH },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
