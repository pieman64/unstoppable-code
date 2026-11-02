import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, discardWorkflowEditIfOpen } from './canopyApp.mjs';
import { seedAutomationTargetProjects } from './automationTargetFixtures.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerShareMembership,
  seedAutomations,
  seedStoredPipeline,
} from './seeders/index.mjs';

// CAN-4915: a prompt automation that names a local pipeline by ID shares that
// pipeline in its capability package, and the recipient's install points the
// prompt at their own copy.
const AUTOMATION_ID = 'journey-specialist';
const PIPELINE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PIPELINE_NAME = 'Journey entry';
const PROMPT = `Run the pipeline ${PIPELINE_ID} and report what it found.`;

function seedFixtures(userDataDir) {
  seedAutomationTargetProjects(userDataDir);
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: PIPELINE_NAME,
    yaml: [
      'pipeline:',
      `  name: ${PIPELINE_NAME}`,
      '  on: dispatch',
      '  jobs:',
      '    journey:',
      '      steps:',
      '        - id: inspect',
      '          run: echo inspect',
      '',
    ].join('\n'),
  });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: AUTOMATION_ID,
        name: 'Daily journey specialist',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: PROMPT },
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
}

test('CAN-4915: shares the pipeline a prompt names and installs a local copy', async () => {
  const apiKey = 'csk_can4915_pipeline_dependencies';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can4915-pipeline-dependencies-'),
  );
  seedFixtures(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(AUTOMATION_ID),
      'share',
    );
    const modal = window.getByTestId('share-automation-modal');
    await expect(modal).toBeVisible();
    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();

    // The prompt names the pipeline by ID, so it is required and packaged.
    await modal.getByTestId('share-automation-advanced-toggle').click();
    const pipelineRow = modal.getByTestId(
      `share-automation-dependencies-pipeline-${PIPELINE_ID}`,
    );
    await expect(pipelineRow).toContainText(PIPELINE_NAME);
    await expect(pipelineRow).toHaveAttribute('data-required', 'true');
    await expect(pipelineRow).toHaveAttribute('data-included', 'true');

    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal.getByTestId('share-automation-success')).toBeVisible();
    await modal.getByTestId('share-automation-done').click();
    await expect(modal).toBeHidden();
    const detail = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      const author = activities.find((entry) => entry.id === id);
      return window.api.automations.getShared(author.remote.remoteId);
    }, AUTOMATION_ID);
    expect(detail.automation.version).toBe(5);
    expect(detail.automation.capabilityPackage).toBeDefined();
    expect(detail.automation.action.pipelineDependencies).toEqual([
      expect.objectContaining({
        key: PIPELINE_ID,
        pipeline: expect.objectContaining({ source: 'packaged' }),
        promptSpans: [
          { textStart: PROMPT.indexOf(PIPELINE_ID), text: PIPELINE_ID },
        ],
      }),
    ]);

    // Without the author's copies the install cannot link back to them, so
    // the recipient gets a pipeline of their own and the prompt follows it.
    await window.evaluate(
      async ({ automationId, pipelineId }) => {
        await window.api.automations.delete({ id: automationId });
        await window.pipelines.delete(pipelineId);
      },
      { automationId: AUTOMATION_ID, pipelineId: PIPELINE_ID },
    );
    await window.evaluate(
      (d) =>
        window.dispatchEvent(
          new CustomEvent('canopy:automations-e2e-install-fixture', {
            detail: {
              id: d.id,
              contentHash: d.contentHash,
              document: d.automation,
            },
          }),
        ),
      detail,
    );
    const installRow = window.getByTestId(
      `install-automation-packaged-pipeline-${PIPELINE_ID}`,
    );
    await expect(installRow).toHaveAttribute('data-status', 'new', {
      timeout: 30_000,
    });
    await expect(installRow).toContainText(PIPELINE_NAME);
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    const installed = await window.evaluate(async () => {
      const { activities } = await window.api.automations.list();
      return activities.find((entry) => entry.installedFrom);
    });
    const [dependency] = installed.installedFrom.pipelineDependencies;
    expect(dependency.key).toBe(PIPELINE_ID);
    expect(dependency.localPipelineId).not.toBe(PIPELINE_ID);
    expect(installed.action.prompt).toBe(
      PROMPT.replace(PIPELINE_ID, dependency.localPipelineId),
    );
    const localPipelines = await window.evaluate(() => window.pipelines.list());
    expect(localPipelines.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: dependency.localPipelineId,
          name: PIPELINE_NAME,
        }),
      ]),
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-4915: the journey-specialist shape. The prompt names an entry pipeline
// and the worker it hands off to; the entry reaches the worker through
// `${{ env.WORKER_PIPELINE }}` and declares a folder of specialist configs.
// Credential files in that folder and per-runner state never travel.
const ENTRY_ID = '6f1c2a9e-0b7d-4c3e-8a5f-1d2e3f4a5b6c';
const WORKER_ID = 'a8d3e1f0-5c6b-4a7d-9e8f-0a1b2c3d4e5f';
const FILES_AUTOMATION_ID = 'journey-specialist-files';
const FILES_PROMPT = `Run ${ENTRY_ID}; it hands each specialist to ${WORKER_ID}.`;

function entryYaml({ specialistsDir, stateDb }) {
  return [
    'name: Journey entry',
    'on: dispatch',
    'env:',
    `  WORKER_PIPELINE: ${WORKER_ID}`,
    'assets:',
    '  - id: specialists',
    `    path: ${specialistsDir}`,
    '    install: replace',
    'local_state:',
    `  - ${stateDb}`,
    'jobs:',
    '  journey:',
    '    steps:',
    '      - id: hand_off',
    '        uses: builtin/run-pipeline',
    '        with:',
    "          pipeline: '${{ env.WORKER_PIPELINE }}'",
    '',
  ].join('\n');
}

function workerYaml(version) {
  return [
    'name: Journey worker',
    'on: dispatch',
    'jobs:',
    '  work:',
    '    steps:',
    '      - id: inspect',
    `        run: echo worker ${version}`,
    '',
  ].join('\n');
}

function seedJourneyPipelines(userDataDir, assets, workerVersion) {
  seedStoredPipeline({
    userDataDir,
    id: WORKER_ID,
    name: 'Journey worker',
    yaml: workerYaml(workerVersion),
  });
  seedStoredPipeline({
    userDataDir,
    id: ENTRY_ID,
    name: 'Journey entry',
    yaml: entryYaml(assets),
  });
}

/** Every file under `root`, relative and `/`-separated. */
function listFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
}

async function shareFromLibrary(window, app, automationId) {
  await app.openAutomationsPage();
  await app.chooseWorkflowsLibraryRowAction(
    app.workflowsLibraryAutomationRow(automationId),
    'share',
  );
  const modal = window.getByTestId('share-automation-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function openInstall(window, detail) {
  await window.evaluate(
    (d) =>
      window.dispatchEvent(
        new CustomEvent('canopy:automations-e2e-install-fixture', {
          detail: {
            id: d.id,
            contentHash: d.contentHash,
            document: d.automation,
          },
        }),
      ),
    detail,
  );
}

test('CAN-4915: an entry pipeline brings its worker and files; credentials and local state stay', async () => {
  const apiKey = 'csk_can4915_pipeline_files';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can4915-pipeline-files-'),
  );
  // Asset paths must sit under the home folder.
  const assetRoot = mkdtempSync(
    path.join(os.homedir(), '.canopy-e2e-can4915-'),
  );
  const specialistsDir = path.join(assetRoot, 'specialists');
  const stateDb = path.join(assetRoot, 'state.db');
  mkdirSync(specialistsDir, { recursive: true });
  writeFileSync(path.join(specialistsDir, 'alpha.json'), '{"name":"alpha"}\n');
  writeFileSync(path.join(specialistsDir, 'beta.json'), '{"name":"beta"}\n');
  writeFileSync(path.join(specialistsDir, '.env'), 'LINEAR_TOKEN=local\n');
  writeFileSync(stateDb, 'runner state\n');
  const assets = { specialistsDir, stateDb };

  seedAutomationTargetProjects(userDataDir);
  seedJourneyPipelines(userDataDir, assets, 'v1');
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: FILES_AUTOMATION_ID,
        name: 'Daily journey specialist with files',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: FILES_PROMPT },
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );

    // Share to a team: both pipelines ship, the worker also as the entry's
    // child, and the credential file is listed as left out.
    let modal = await shareFromLibrary(window, app, FILES_AUTOMATION_ID);
    await modal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Team' })
      .click();
    await modal.getByRole('button', { name: /Platform/ }).click();
    await modal.getByTestId('share-automation-advanced-toggle').click();
    for (const id of [ENTRY_ID, WORKER_ID]) {
      const row = modal.getByTestId(
        `share-automation-dependencies-pipeline-${id}`,
      );
      await expect(row).toHaveAttribute('data-required', 'true', {
        timeout: 30_000,
      });
      await expect(row).toHaveAttribute('data-included', 'true');
    }
    // A slow host finishes an account re-read (ambient, or the dialog's own
    // access check for the picked team) after More details is open. The
    // review must stay where the author opened it.
    await window.evaluate(async () => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      // A read issued after the dialog's own one, then a frame for React.
      await window.api.loadCanopyCloudAccount();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    // Share is held while the read is pending; once it is back, the read has
    // settled and the review must still be open.
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled({
      timeout: 30_000,
    });
    await expect(
      modal.getByTestId('share-automation-advanced-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      modal.getByTestId(`share-automation-dependencies-pipeline-${ENTRY_ID}`),
    ).toBeVisible();
    // Withheld files stay visible even when there are no optional files.
    await expect(
      modal.getByTestId('share-automation-dependencies-withheld'),
    ).toContainText('specialists/.env');
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal.getByTestId('share-automation-success')).toBeVisible();
    await modal.getByTestId('share-automation-done').click();
    await expect(modal).toBeHidden();

    const remoteId = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((entry) => entry.id === id).remote.remoteId;
    }, FILES_AUTOMATION_ID);
    const detail = await window.evaluate(
      (id) => window.api.automations.getShared(id),
      remoteId,
    );
    expect(detail.automation.version).toBe(5);
    expect(
      detail.automation.action.pipelineDependencies.map(
        (dependency) => dependency.key,
      ),
    ).toEqual([ENTRY_ID, WORKER_ID]);

    // Without the author's copies the install cannot link back to them, so
    // the recipient gets pipelines of their own.
    await window.evaluate(
      async (ids) => {
        for (const id of ids) await window.pipelines.delete(id);
      },
      [ENTRY_ID, WORKER_ID],
    );
    await openInstall(window, detail);
    for (const id of [ENTRY_ID, WORKER_ID]) {
      await expect(
        window.getByTestId(`install-automation-packaged-pipeline-${id}`),
      ).toHaveAttribute('data-status', 'new', { timeout: 30_000 });
    }
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    const installed = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((entry) => entry.installedFrom?.remoteId === id);
    }, remoteId);
    const localIdFor = (key) =>
      installed.installedFrom.pipelineDependencies.find(
        (dependency) => dependency.key === key,
      ).localPipelineId;
    const localEntryId = localIdFor(ENTRY_ID);
    const localWorkerId = localIdFor(WORKER_ID);
    expect(localEntryId).not.toBe(ENTRY_ID);
    expect(localWorkerId).not.toBe(WORKER_ID);
    // Required-file details are summarized in the share dialog. Verify the
    // child reference survives in the recipient's actual pipeline YAML.
    const localEntry = await window.evaluate(
      (id) => window.pipelines.get({ id, source: 'user' }),
      localEntryId,
    );
    expect(localEntry.data?.rawContent).toContain('${{ env.WORKER_PIPELINE }}');
    expect(installed.action.prompt).toBe(
      FILES_PROMPT.replace(ENTRY_ID, localEntryId).replace(
        WORKER_ID,
        localWorkerId,
      ),
    );
    // The specialist configs are installed under the entry's data folder;
    // the credential file and the runner state are not anywhere.
    const installedSpecialists = path.join(
      userDataDir,
      'pipeline-data',
      localEntryId,
      'assets',
      'specialists',
    );
    expect(listFiles(installedSpecialists)).toEqual([
      'alpha.json',
      'beta.json',
    ]);
    expect(
      listFiles(path.join(userDataDir, 'pipeline-data')).filter(
        (file) => file.endsWith('.env') || file.endsWith('state.db'),
      ),
    ).toEqual([]);

    // Update: the author changes the worker and shares again. The recipient
    // edited one installed file, which `replace` will overwrite.
    seedJourneyPipelines(userDataDir, assets, 'v2');
    writeFileSync(
      path.join(installedSpecialists, 'beta.json'),
      '{"name":"my beta"}\n',
    );
    modal = await shareFromLibrary(window, app, FILES_AUTOMATION_ID);
    await modal.getByTestId('share-automation-advanced-toggle').click();
    await expect(
      modal.getByTestId(`share-automation-dependencies-pipeline-${WORKER_ID}`),
    ).toHaveAttribute('data-included', 'true', { timeout: 30_000 });
    await expect(modal.getByTestId('share-automation-submit')).toBeEnabled();
    await modal.getByTestId('share-automation-submit').click();
    await expect(modal.getByTestId('share-automation-success')).toBeVisible();
    await modal.getByTestId('share-automation-done').click();
    await expect(modal).toBeHidden();
    const updated = await window.evaluate(
      (id) => window.api.automations.getShared(id),
      remoteId,
    );
    // The worker's new YAML is a new package; the mock keeps one content
    // hash per share, so the update fixture names its own.
    expect(updated.automation.capabilityPackage.digest).not.toBe(
      detail.automation.capabilityPackage.digest,
    );

    // One app plays both people: while the author's copy exists the share
    // reads as theirs, not as an update to the installed copy.
    await window.evaluate(
      async ({ automationId, pipelineIds }) => {
        await window.api.automations.delete({ id: automationId });
        for (const id of pipelineIds) await window.pipelines.delete(id);
      },
      { automationId: FILES_AUTOMATION_ID, pipelineIds: [ENTRY_ID, WORKER_ID] },
    );
    await openInstall(window, { ...updated, contentHash: 'e'.repeat(64) });
    const workerRow = window.getByTestId(
      `install-automation-packaged-pipeline-${WORKER_ID}`,
    );
    await expect(workerRow).toHaveAttribute('data-status', 'update', {
      timeout: 30_000,
    });
    await workerRow
      .getByTestId(`install-automation-packaged-pipeline-${WORKER_ID}-review`)
      .click();
    await expect(
      workerRow.getByTestId(
        `install-automation-packaged-pipeline-${WORKER_ID}-yaml`,
      ),
    ).toContainText('echo worker v2');
    const entryRow = window.getByTestId(
      `install-automation-packaged-pipeline-${ENTRY_ID}`,
    );
    await expect(entryRow).toHaveAttribute('data-status', 'unchanged');
    await expect(
      entryRow.getByTestId(
        `install-automation-packaged-pipeline-${ENTRY_ID}-files`,
      ),
    ).toContainText(
      'Overwrites 1 file you changed in “specialists”: beta.json',
    );
    await window.getByTestId('install-automation-submit').click();
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toBeHidden();

    // The update keeps the recipient's copies and the rewritten prompt.
    const afterUpdate = await window.evaluate(async (id) => {
      const { activities } = await window.api.automations.list();
      return activities.find((entry) => entry.installedFrom?.remoteId === id);
    }, remoteId);
    expect(afterUpdate.id).toBe(installed.id);
    expect(afterUpdate.action.prompt).toBe(installed.action.prompt);
    expect(
      readFileSync(
        path.join(userDataDir, 'pipelines', `${localWorkerId}.yaml`),
        'utf8',
      ),
    ).toContain('echo worker v2');
    expect(
      readFileSync(path.join(installedSpecialists, 'beta.json'), 'utf8'),
    ).toBe('{"name":"beta"}\n');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(assetRoot, { recursive: true, force: true });
  }
});
