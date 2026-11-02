// Self-contained pipeline package installation — durable Electron coverage.
//
// The local HTTP fixture serves a pinned public snapshot, its canonical
// manifest, and content-addressed blobs. The recipient starts with no private
// skill/plugin catalog. Emitting the exact web CTA deep link opens the install
// review and writes nothing; its one Install click installs (CAN-3710),
// preserves step-scoped readiness, and leaves global capability inventory
// unchanged. Definition-only coverage
// proves missing packaged content remains visible and run-blocking after the
// YAML is installed. A final fixture corrupts the blob to prove verification
// failure leaves no pipeline, ledger row, or staging directory behind.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const SHARE_ID = '4f4f51c1-a72b-4e12-9320-a038b90189f0';
const BROKEN_SHARE_ID = '81486a6e-fc43-47ff-a613-70b85ed2df5a';
const DEFINITION_ONLY_SHARE_ID = '2cf0ab43-a059-4b60-af81-bc6a51ff626d';
const RAW_PIPELINE = [
  'name: Packaged Private Review',
  'description: Uses packaged private capabilities',
  'on:',
  '  dispatch:',
  '    inputs:',
  '      task:',
  '        description: Optional review context',
  '        required: false',
  'jobs:',
  '  review:',
  '    steps:',
  '      - id: packaged_action',
  '        uses: project/review',
  '      - id: packaged_child',
  '        uses: builtin/run-pipeline',
  '        with:',
  '          pipeline: children/review.yaml',
].join('\n');
const UPDATED_RAW_PIPELINE = RAW_PIPELINE.replace(
  'description: Uses packaged private capabilities',
  'description: Uses updated packaged private capabilities',
);
const SKILL_BYTES = Buffer.from(
  [
    '---',
    'name: private-review',
    'description: Packaged private review fixture',
    '---',
    '# Private review',
    'Review the current change and report the result.',
    '',
  ].join('\n'),
);
const ACTION_BYTES = Buffer.from(
  [
    'name: Packaged project review',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - id: action_marker',
    '      run: echo PACKAGED_ACTION_RUNTIME_OK',
    '',
  ].join('\n'),
);
const CHILD_PIPELINE_BYTES = Buffer.from(
  [
    'name: Packaged child review',
    'on: dispatch',
    'jobs:',
    '  child:',
    '    steps:',
    '      - id: child_marker',
    '        run: echo PACKAGED_CHILD_RUNTIME_OK',
    '',
  ].join('\n'),
);
const PIPELINE_HASH = createHash('sha256').update(RAW_PIPELINE).digest('hex');
const UPDATED_PIPELINE_HASH = createHash('sha256')
  .update(UPDATED_RAW_PIPELINE)
  .digest('hex');
const SKILL_HASH = createHash('sha256').update(SKILL_BYTES).digest('hex');
const ACTION_HASH = createHash('sha256').update(ACTION_BYTES).digest('hex');
const CHILD_PIPELINE_HASH = createHash('sha256')
  .update(CHILD_PIPELINE_BYTES)
  .digest('hex');
const RESOURCE_ID = 'private-review';
const ACTION_RESOURCE_ID = 'project-review-action';
const CHILD_PIPELINE_RESOURCE_ID = 'relative-review-pipeline';
const ENVIRONMENT_REQUIREMENT = {
  id: 'fixture-cli',
  kind: 'command',
  displayName: 'canopy-e2e-missing-cli',
  required: false,
  affectedSteps: [{ jobId: 'review', stepId: 'packaged_action' }],
  setupHint: 'Install the optional fixture CLI.',
};
const MANIFEST = {
  version: 1,
  pipelineContentHash: PIPELINE_HASH,
  resources: [
    {
      id: RESOURCE_ID,
      kind: 'standalone_skill',
      displayName: '$private-review',
      sourceLabel: 'Private Review Marketplace',
      sourceVisibility: 'private',
      invocationKeys: ['$private-review'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'codex',
          runtimeKind: 'standalone_skill',
          rootName: 'private-review',
          entries: [
            {
              path: 'SKILL.md',
              sha256: SKILL_HASH,
              size: SKILL_BYTES.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    },
    {
      id: ACTION_RESOURCE_ID,
      kind: 'pipeline_action',
      displayName: 'project/review',
      sourceLabel: 'Private project action',
      sourceVisibility: 'private',
      invocationKeys: ['project/review'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'standalone_skill',
          rootName: 'review',
          entries: [
            {
              path: 'action.yml',
              sha256: ACTION_HASH,
              size: ACTION_BYTES.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    },
    {
      id: CHILD_PIPELINE_RESOURCE_ID,
      kind: 'child_pipeline',
      displayName: 'children/review.yaml',
      sourceLabel: 'Private child pipeline',
      sourceVisibility: 'private',
      invocationKeys: ['children/review.yaml'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'plugin_fragment',
          rootName: 'pipelines-fixture',
          entries: [
            {
              path: 'children/review.yaml',
              sha256: CHILD_PIPELINE_HASH,
              size: CHILD_PIPELINE_BYTES.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    },
  ],
  bindings: [
    {
      jobId: 'review',
      stepId: 'packaged_action',
      resourceIds: [RESOURCE_ID, ACTION_RESOURCE_ID],
    },
    {
      jobId: 'review',
      stepId: 'packaged_child',
      resourceIds: [CHILD_PIPELINE_RESOURCE_ID],
    },
  ],
  environmentRequirements: [ENVIRONMENT_REQUIREMENT],
  totalFiles: 3,
  totalBytes:
    SKILL_BYTES.byteLength +
    ACTION_BYTES.byteLength +
    CHILD_PIPELINE_BYTES.byteLength,
};
const PACKAGE_DIGEST = `pp:v1:${createHash('sha256')
  .update(JSON.stringify(MANIFEST))
  .digest('base64url')}`;
const UPDATED_MANIFEST = {
  ...MANIFEST,
  pipelineContentHash: UPDATED_PIPELINE_HASH,
};
const DEPENDENCY_UPDATED_MANIFEST = {
  ...MANIFEST,
  environmentRequirements: [
    {
      ...ENVIRONMENT_REQUIREMENT,
      setupHint: 'Install the updated optional fixture CLI.',
    },
  ],
};
const DEPENDENCY_UPDATED_PACKAGE_DIGEST = `pp:v1:${createHash('sha256')
  .update(JSON.stringify(DEPENDENCY_UPDATED_MANIFEST))
  .digest('base64url')}`;
const UPDATED_PACKAGE_DIGEST = `pp:v1:${createHash('sha256')
  .update(JSON.stringify(UPDATED_MANIFEST))
  .digest('base64url')}`;
const PACKAGE_SUMMARY = {
  digest: PACKAGE_DIGEST,
  version: 1,
  resources: [
    {
      id: RESOURCE_ID,
      displayName: '$private-review',
      kind: 'standalone_skill',
      sourceLabel: 'Private Review Marketplace',
      fileCount: 1,
      totalBytes: SKILL_BYTES.byteLength,
      affectedSteps: [{ jobId: 'review', stepId: 'packaged_action' }],
    },
    {
      id: ACTION_RESOURCE_ID,
      displayName: 'project/review',
      kind: 'pipeline_action',
      sourceLabel: 'Private project action',
      fileCount: 1,
      totalBytes: ACTION_BYTES.byteLength,
      affectedSteps: [{ jobId: 'review', stepId: 'packaged_action' }],
    },
    {
      id: CHILD_PIPELINE_RESOURCE_ID,
      displayName: 'children/review.yaml',
      kind: 'child_pipeline',
      sourceLabel: 'Private child pipeline',
      fileCount: 1,
      totalBytes: CHILD_PIPELINE_BYTES.byteLength,
      affectedSteps: [{ jobId: 'review', stepId: 'packaged_child' }],
    },
  ],
  environmentRequirements: [ENVIRONMENT_REQUIREMENT],
  totalFiles: 3,
  totalBytes:
    SKILL_BYTES.byteLength +
    ACTION_BYTES.byteLength +
    CHILD_PIPELINE_BYTES.byteLength,
};

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

function snapshot(externalId, packageFixture) {
  return {
    entity: 'pipeline',
    externalId,
    name: 'Packaged Private Review',
    description: packageFixture.description,
    rawPipeline: packageFixture.rawPipeline,
    contentHash: packageFixture.pipelineHash,
    distributionMode: 'package',
    package: {
      ...PACKAGE_SUMMARY,
      digest: packageFixture.packageDigest,
    },
    authorUsername: 'fixture-author',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function definitionOnlySnapshot(
  externalId,
  pipelineFixture = {
    description: 'Definition only; private skill is not included',
    rawPipeline: RAW_PIPELINE,
    pipelineHash: PIPELINE_HASH,
  },
) {
  return {
    entity: 'pipeline',
    externalId,
    name: 'Packaged Private Review',
    description: pipelineFixture.description,
    rawPipeline: pipelineFixture.rawPipeline,
    contentHash: pipelineFixture.pipelineHash,
    distributionMode: 'definition_only',
    authorUsername: 'fixture-author',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function startPackageCloud() {
  const requests = [];
  let definitionOnly = false;
  let delayedPackageResponse = null;
  let packageFailuresRemaining = 0;
  let packageFixture = {
    description: 'Uses packaged private capabilities',
    rawPipeline: RAW_PIPELINE,
    pipelineHash: PIPELINE_HASH,
    packageDigest: PACKAGE_DIGEST,
    manifest: MANIFEST,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: Object.fromEntries(url.searchParams),
      version: request.headers['x-pipeline-package-version'],
    });
    const shareMatch = url.pathname.match(
      /^\/api\/v1\/desktop-app\/public-shares\/pipelines\/([^/]+)$/,
    );
    if (request.method === 'GET' && shareMatch) {
      sendJson(
        response,
        200,
        shareMatch[1] === DEFINITION_ONLY_SHARE_ID
          ? definitionOnlySnapshot(shareMatch[1])
          : definitionOnly
            ? definitionOnlySnapshot(shareMatch[1], packageFixture)
            : snapshot(shareMatch[1], packageFixture),
      );
      return;
    }
    const packageMatch = url.pathname.match(
      /^\/api\/v1\/public-shares\/pipelines\/([^/]+)\/package$/,
    );
    if (request.method === 'GET' && packageMatch) {
      const sendPackage = () => {
        sendJson(response, 200, {
          digest: packageFixture.packageDigest,
          manifest: packageFixture.manifest,
        });
      };
      if (packageFailuresRemaining > 0) {
        packageFailuresRemaining -= 1;
        sendJson(response, 503, { error: 'Delayed package failure' });
        return;
      }
      if (delayedPackageResponse) {
        const pending = delayedPackageResponse;
        delayedPackageResponse = null;
        pending.markStarted();
        void pending.releaseSignal.then((outcome) => {
          if (outcome === 'fail') {
            sendJson(response, 503, { error: 'Delayed package failure' });
          } else {
            sendPackage();
          }
        });
      } else {
        sendPackage();
      }
      return;
    }
    const blobMatch = url.pathname.match(
      /^\/api\/v1\/public-shares\/pipelines\/([^/]+)\/package\/blobs\/([^/]+)$/,
    );
    if (request.method === 'GET' && blobMatch) {
      const bytes =
        blobMatch[1] === BROKEN_SHARE_ID
          ? Buffer.from('corrupted package blob')
          : blobMatch[2] === ACTION_HASH
            ? ACTION_BYTES
            : blobMatch[2] === CHILD_PIPELINE_HASH
              ? CHILD_PIPELINE_BYTES
              : SKILL_BYTES;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      });
      response.end(bytes);
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/v1/desktop-app/share-events/desktop-handoff'
    ) {
      request.resume();
      request.on('end', () => sendJson(response, 200, { recorded: true }));
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        publishUpdate: () => {
          packageFixture = {
            description: 'Uses updated packaged private capabilities',
            rawPipeline: UPDATED_RAW_PIPELINE,
            pipelineHash: UPDATED_PIPELINE_HASH,
            packageDigest: UPDATED_PACKAGE_DIGEST,
            manifest: UPDATED_MANIFEST,
          };
        },
        publishDependencyOnlyUpdate: () => {
          packageFixture = {
            description: 'Uses packaged private capabilities',
            rawPipeline: RAW_PIPELINE,
            pipelineHash: PIPELINE_HASH,
            packageDigest: DEPENDENCY_UPDATED_PACKAGE_DIGEST,
            manifest: DEPENDENCY_UPDATED_MANIFEST,
          };
        },
        publishDefinitionOnly: () => {
          definitionOnly = true;
        },
        delayNextPackageResponse: () => {
          let markStarted;
          let resolveResponse;
          const started = new Promise((resolveStarted) => {
            markStarted = resolveStarted;
          });
          const releaseSignal = new Promise((resolveRelease) => {
            resolveResponse = resolveRelease;
          });
          delayedPackageResponse = {
            markStarted,
            releaseSignal,
          };
          return {
            started,
            release: () => resolveResponse('success'),
            fail: () => {
              // Idempotent cloud reads retry twice after the initial request.
              // Fail those retries too so this fixture reaches terminal error
              // handling; the next explicit install attempt may then succeed.
              packageFailuresRemaining = 2;
              resolveResponse('fail');
            },
          };
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function installLink(
  externalId,
  { pipelineHash = PIPELINE_HASH, packageDigest = PACKAGE_DIGEST } = {},
) {
  const query = new URLSearchParams({
    source: 'web_share_page',
    packageVersion: '1',
    expectedPipelineContentHash: pipelineHash,
    expectedDistributionMode: 'package',
    expectedPackageDigest: packageDigest,
  });
  return `canopy://share/pipelines/${externalId}?${query.toString()}`;
}

// `intent=try` on an installed pipeline stages its run straight away.
function tryLink(externalId, pins) {
  return `${installLink(externalId, pins)}&intent=try`;
}

// CAN-3710: Install is the one click; the review closes and the notice says
// what landed.
async function installFromReview(window, modal, notice) {
  await modal.getByTestId('deep-link-share-install').click();
  await expect(modal).toHaveCount(0, { timeout: 30_000 });
  await expect(
    window.getByTestId('toast-card').filter({ hasText: notice }),
  ).toBeVisible();
}

function definitionOnlyInstallLink(externalId, pipelineHash = PIPELINE_HASH) {
  const query = new URLSearchParams({
    source: 'web_share_page',
    expectedPipelineContentHash: pipelineHash,
    expectedDistributionMode: 'definition_only',
  });
  return `canopy://share/pipelines/${externalId}?${query.toString()}`;
}

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

function ledger(userDataDir) {
  const target = path.join(userDataDir, 'pipeline-package-installs.json');
  return existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;
}

/** Ledger rows are owner-keyed so automations can share the same store. */
function installedPipelineId(record) {
  // Throw rather than return undefined: two missing ids would otherwise
  // compare equal and let identity assertions pass vacuously.
  if (
    record?.owner?.kind !== 'pipeline' ||
    typeof record.owner.localPipelineId !== 'string'
  ) {
    throw new Error(
      `Expected a pipeline-owned install record, got ${JSON.stringify(record)}`,
    );
  }
  return record.owner.localPipelineId;
}

function pipelineOwner(localPipelineId) {
  return { owner: { kind: 'pipeline', localPipelineId } };
}

test('web install deep link atomically installs a pinned package without global catalog activation', async () => {
  test.setTimeout(120_000);
  const cloud = await startPackageCloud();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-package-install-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const inventoryBefore = await window.evaluate(async () =>
      window.invocableInventory.list({ providerType: null }),
    );

    // This event is the web CTA click. It opens the install review and
    // writes nothing until Install is clicked.
    await emitOpenUrl(electronApp, installLink(SHARE_ID));
    const modal = window.getByTestId('deep-link-share-landing');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Packaged Private Review');
    await expect(modal.getByTestId('deep-link-share-install')).toBeEnabled();
    expect(ledger(userDataDir)).toBeNull();
    await installFromReview(window, modal, 'Installed with 3 dependencies.');

    const packageRequests = cloud.requests.filter((request) =>
      request.pathname.includes('/package'),
    );
    expect(packageRequests).toHaveLength(4);
    for (const request of packageRequests) {
      // Desktop requests its current package contract
      // (PIPELINE_PACKAGE_CLIENT_VERSION, 6 for automation resources).
      expect(request.version).toBe('6');
      expect(request.search.expectedPackageDigest).toBe(PACKAGE_DIGEST);
    }
    const snapshotRequest = cloud.requests.find((request) =>
      request.pathname.endsWith(`/pipelines/${SHARE_ID}`),
    );
    expect(snapshotRequest?.search).toMatchObject({
      expectedPipelineContentHash: PIPELINE_HASH,
      expectedDistributionMode: 'package',
      expectedPackageDigest: PACKAGE_DIGEST,
    });

    const installs = ledger(userDataDir);
    expect(installs?.records).toHaveLength(1);
    expect(installs.records[0]).toMatchObject({
      originExternalId: SHARE_ID,
      pipelineContentHash: PIPELINE_HASH,
      packageDigest: PACKAGE_DIGEST,
    });
    expect(
      existsSync(
        path.join(
          userDataDir,
          'pipeline-packages',
          'v1',
          'packages',
          PACKAGE_DIGEST.slice('pp:v1:'.length),
          'materialized',
          RESOURCE_ID,
          'codex',
          'private-review',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          userDataDir,
          'pipeline-packages',
          'v1',
          'packages',
          PACKAGE_DIGEST.slice('pp:v1:'.length),
          'materialized',
          ACTION_RESOURCE_ID,
          'claude',
          'review',
          'action.yml',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          userDataDir,
          'pipeline-packages',
          'v1',
          'packages',
          PACKAGE_DIGEST.slice('pp:v1:'.length),
          'materialized',
          CHILD_PIPELINE_RESOURCE_ID,
          'claude',
          'pipelines-fixture',
          'children',
          'review.yaml',
        ),
      ),
    ).toBe(true);

    const inventoryAfter = await window.evaluate(async () =>
      window.invocableInventory.list({ providerType: null }),
    );
    expect(inventoryAfter.data?.entries ?? []).toEqual(
      inventoryBefore.data?.entries ?? [],
    );

    // Run the recipient copy. With no matching workspace action or child
    // pipeline on disk, success proves both steps resolved through the package
    // overlay installed from the share. A try link stages the run.
    await emitOpenUrl(electronApp, tryLink(SHARE_ID));
    const runtimeTrigger = window.getByTestId('pipeline-trigger-modal');
    await expect(runtimeTrigger).toBeVisible({ timeout: 30_000 });
    await runtimeTrigger.getByTestId('pipeline-trigger-modal-run').click();
    await expect(
      runtimeTrigger.getByTestId('pipeline-trigger-modal-package-readiness'),
    ).toBeVisible();
    const runtimeRun = runtimeTrigger.getByTestId('pipeline-trigger-modal-run');
    await expect(runtimeRun).toBeEnabled();
    await runtimeRun.click();
    const runCard = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: 'Packaged Private Review' })
      .first();
    await expect(runCard).toBeVisible({ timeout: 30_000 });
    await expect(runCard).toContainText('success', { timeout: 60_000 });

    // Reopening the install link finds the installed copy: the review offers
    // to open it and installs nothing again.
    const initiallyInstalled = installs.records[0];
    await emitOpenUrl(electronApp, installLink(SHARE_ID));
    await expect(modal.getByTestId('deep-link-share-open')).toBeVisible({
      timeout: 30_000,
    });
    await expect(modal.getByTestId('deep-link-share-install')).toHaveCount(0);
    expect(ledger(userDataDir)?.records).toEqual([initiallyInstalled]);
    await window.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    cloud.publishUpdate();
    await emitOpenUrl(
      electronApp,
      installLink(SHARE_ID, {
        pipelineHash: UPDATED_PIPELINE_HASH,
        packageDigest: UPDATED_PACKAGE_DIGEST,
      }),
    );
    await expect(modal.getByTestId('deep-link-share-install')).toBeVisible();
    await modal.getByTestId('deep-link-share-install').click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });

    const updatedInstalls = ledger(userDataDir);
    expect(updatedInstalls?.records).toHaveLength(1);
    expect(updatedInstalls.records[0]).toMatchObject({
      ...pipelineOwner(installedPipelineId(initiallyInstalled)),
      originExternalId: SHARE_ID,
      pipelineContentHash: UPDATED_PIPELINE_HASH,
      packageDigest: UPDATED_PACKAGE_DIGEST,
    });
    const updatedPipelines = await window.evaluate(async () =>
      window.pipelines.list(),
    );
    expect(
      updatedPipelines.data?.find(
        (pipeline) => pipeline.id === installedPipelineId(initiallyInstalled),
      ),
    ).toMatchObject({
      id: installedPipelineId(initiallyInstalled),
      description: 'Uses updated packaged private capabilities',
    });

    await emitOpenUrl(
      electronApp,
      tryLink(SHARE_ID, {
        pipelineHash: UPDATED_PIPELINE_HASH,
        packageDigest: UPDATED_PACKAGE_DIGEST,
      }),
    );
    const trigger = window.getByTestId('pipeline-trigger-modal');
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.getByTestId('pipeline-trigger-modal-run').click();
    const readiness = trigger.getByTestId(
      'pipeline-trigger-modal-package-readiness',
    );
    await expect(readiness).toBeVisible();
    await expect(readiness).toContainText('canopy-e2e-missing-cli');
    await expect(readiness).toContainText('Missing');

    await window.keyboard.press('Escape');
    cloud.publishDefinitionOnly();
    await emitOpenUrl(
      electronApp,
      definitionOnlyInstallLink(SHARE_ID, UPDATED_PIPELINE_HASH),
    );
    await installFromReview(
      window,
      modal,
      'Workflow definition installed without dependencies.',
    );

    const definitionOnlyInstalls = ledger(userDataDir);
    expect(definitionOnlyInstalls?.records).toHaveLength(1);
    expect(definitionOnlyInstalls.records[0]).toMatchObject({
      ...pipelineOwner(installedPipelineId(initiallyInstalled)),
      originExternalId: SHARE_ID,
      pipelineContentHash: UPDATED_PIPELINE_HASH,
      distributionMode: 'definition_only',
    });
    expect(definitionOnlyInstalls.records[0]).not.toHaveProperty(
      'packageDigest',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('definition-only install preserves missing-content readiness and blocks Run', async () => {
  const cloud = await startPackageCloud();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-definition-only-install-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedStoredPipeline({
    userDataDir,
    id: 'preexisting-definition-only',
    name: 'Packaged Private Review',
    description: 'Uses packaged private capabilities',
    yaml: RAW_PIPELINE,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    await emitOpenUrl(
      electronApp,
      definitionOnlyInstallLink(DEFINITION_ONLY_SHARE_ID),
    );
    const modal = window.getByTestId('deep-link-share-landing');
    await installFromReview(
      window,
      modal,
      'Workflow definition installed without dependencies.',
    );

    const installs = ledger(userDataDir);
    expect(installs?.records).toHaveLength(1);
    expect(installs.records[0]).toMatchObject({
      ...pipelineOwner('preexisting-definition-only'),
      originExternalId: DEFINITION_ONLY_SHARE_ID,
      pipelineContentHash: PIPELINE_HASH,
      distributionMode: 'definition_only',
    });
    expect(installs.records[0]).not.toHaveProperty('packageDigest');

    await emitOpenUrl(
      electronApp,
      `${definitionOnlyInstallLink(DEFINITION_ONLY_SHARE_ID)}&intent=try`,
    );
    const trigger = window.getByTestId('pipeline-trigger-modal');
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.getByTestId('pipeline-trigger-modal-run').click();
    await expect(
      trigger.getByTestId('pipeline-trigger-modal-definition-only-note'),
    ).toBeVisible();
    await expect(
      trigger.getByTestId('pipeline-trigger-modal-run'),
    ).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('blob verification failure leaves no pipeline, ledger row, or staged package', async () => {
  const cloud = await startPackageCloud();
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const before = await window.evaluate(async () => window.pipelines.list());

    await emitOpenUrl(electronApp, installLink(BROKEN_SHARE_ID));
    const modal = window.getByTestId('deep-link-share-landing');
    await modal.getByTestId('deep-link-share-install').click();
    // The failure keeps the review open on its error, with Install to retry.
    await expect(modal).toContainText(/wrong size|failed verification/, {
      timeout: 30_000,
    });
    await expect(modal.getByTestId('deep-link-share-install')).toBeEnabled();
    const after = await window.evaluate(async () => window.pipelines.list());
    expect(after.data).toEqual(before.data);
    expect(ledger(userDataDir)?.records ?? []).toEqual([]);
    const packageRoot = path.join(
      userDataDir,
      'pipeline-packages',
      'v1',
      'packages',
    );
    expect(
      existsSync(packageRoot)
        ? readdirSync(packageRoot).filter((name) =>
            name.startsWith('.staging-'),
          )
        : [],
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
